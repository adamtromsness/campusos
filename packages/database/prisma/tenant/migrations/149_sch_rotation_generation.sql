/*
 * 149_sch_rotation_generation.sql — Phase 2 Cycle 17 sub-cycle a (P2-17a).
 *
 * M22 Scheduling Advanced — first 10 of 20 tables. Wave C closeout.
 *
 *   sch_rotation_cycles            Rotation cycle definitions (A/B
 *                                  week, 6-day rotation, etc).
 *                                  cycle_length carries the number
 *                                  of distinct rotation days (2 for
 *                                  A/B, 6 for 6-day). UNIQUE
 *                                  (school_id, name).
 *   sch_rotation_calendar          Date to rotation_day mapping.
 *                                  Admin maintains and adjusts for
 *                                  closures. UNIQUE(rotation_cycle_id
 *                                  calendar_date). rotation_day
 *                                  bounded by parent cycle_length
 *                                  via CHECK plus app validation at
 *                                  insert time (no FK on the bound
 *                                  since cycle_length is variable).
 *   sch_scheduling_constraints     Hard plus soft constraint
 *                                  profiles for the solver. JSONB
 *                                  hard_constraints H1..H5 and soft
 *                                  S1..S5 plus weights per ADR-053.
 *                                  UNIQUE(school_id academic_year_id
 *                                  name).
 *   sch_student_subject_choices    Demand input from students for
 *                                  the solver. UNIQUE(student_id
 *                                  academic_year_id course_id) caps
 *                                  one row per student-year-course.
 *   sch_scheduling_requests        Solver invocation row. 2-value
 *                                  solver_algorithm CHECK (CP_SAT
 *                                  HEURISTIC) selected by ADR-060
 *                                  threshold (CP_SAT for sections
 *                                  less-or-equal 300 HEURISTIC for
 *                                  greater than 300). 5-value status
 *                                  CHECK (QUEUED RUNNING COMPLETED
 *                                  FAILED CANCELLED) with multi-
 *                                  column lifecycle_chk lockstep
 *                                  pinning started_at and
 *                                  completed_at to the right states.
 *                                  Emits sch.generation.completed on
 *                                  COMPLETED transition.
 *   sch_scheduling_candidates      Solver-produced candidate
 *                                  solutions. 4-value review_status
 *                                  CHECK (PENDING APPROVED REJECTED
 *                                  MODIFIED). constraint_violations
 *                                  JSONB carries the per-rule
 *                                  violation summary. The promotion
 *                                  lifecycle is review_status =
 *                                  PENDING (DRAFT) then REVIEWED
 *                                  then APPROVED then ACTIVE — the
 *                                  ScheduleGenerationService blocks
 *                                  the activate path when any
 *                                  sch_scheduling_candidate_slots row
 *                                  carries has_clash=true.
 *   sch_scheduling_candidate_slots Per-candidate slot proposals.
 *                                  has_clash plus clash_description
 *                                  surface unresolved conflicts to
 *                                  the admin review UI. On APPROVED
 *                                  the SchedulingActivationWorker
 *                                  promotes each row into a fresh
 *                                  sch_timetable_slots entry.
 *   sch_scheduling_activation_log  Append-only audit of every
 *                                  candidate promotion. Records the
 *                                  slots_promoted and slots_skipped
 *                                  counts and the activator account.
 *   sch_subject_choice_windows     Per-school time window controlling
 *                                  when students can submit subject
 *                                  choices. UNIQUE(school_id
 *                                  academic_year_id). target_grade
 *                                  _levels TEXT[] restricts the
 *                                  window to specific grades.
 *
 * Cross-cycle integration:
 *   - sch_rotation_cycles.academic_year_id is a soft FK to
 *     sis_academic_years per ADR-001 and ADR-020.
 *   - sch_scheduling_requests.constraint_id is a DB-enforced FK to
 *     sch_scheduling_constraints with ON DELETE RESTRICT.
 *   - sch_scheduling_candidates.request_id is a DB-enforced FK to
 *     sch_scheduling_requests with ON DELETE CASCADE — the candidates
 *     have no meaning without their parent request.
 *   - sch_scheduling_candidate_slots.candidate_id is a DB-enforced FK
 *     to sch_scheduling_candidates with ON DELETE CASCADE.
 *   - sch_scheduling_candidate_slots.class_id is a soft FK to
 *     sis_classes per ADR-001 (nullable to allow placeholder slots
 *     during heuristic exploration).
 *   - sch_scheduling_candidate_slots.teacher_id is a soft FK to
 *     hr_employees per ADR-001.
 *   - sch_scheduling_candidate_slots.room_id is a soft FK to
 *     sch_rooms per ADR-001.
 *   - sch_scheduling_candidate_slots.period_id is a soft FK to
 *     sch_periods per ADR-001.
 *   - sch_student_subject_choices.student_id is a DB-enforced FK to
 *     sis_students with ON DELETE CASCADE.
 *   - sch_student_subject_choices.course_id is a soft FK to
 *     sis_courses per ADR-001 and ADR-020.
 *   - sch_scheduling_activation_log.candidate_id is a DB-enforced FK
 *     to sch_scheduling_candidates with ON DELETE CASCADE.
 *
 * ALTER sch_periods ADD rotation_day SMALLINT — added at the end of
 * this migration so the existing seed continues to work. The new
 * column is nullable and unconstrained — a period without a rotation
 * day applies every rotation_day in the cycle (the legacy shape).
 * When set rotation_day is 1..N where N is the parent cycle's
 * cycle_length (validated at the application layer when the period
 * links to a rotation cycle).
 *
 * sch_room_change_requests already exists from Cycle 5 migration 016
 * — P2-17a does not re-create the table. The existing 4-value status
 * (PENDING APPROVED REJECTED AUTO_APPROVED) is a superset of the
 * P2-17a-described 3-value status and the existing columns cover the
 * P2-17a use case unchanged. This migration only references it for
 * documentation completeness.
 *
 * Splitter discipline — no semicolons inside string literals default
 * expressions COMMENT bodies CHECK predicates or block comments. The
 * splitter cuts on every semicolon regardless of quoting context.
 * Idempotent — safe to re-run.
 */

CREATE TABLE IF NOT EXISTS sch_rotation_cycles (
  id                  UUID PRIMARY KEY,
  school_id           UUID NOT NULL,
  name                TEXT NOT NULL,
  cycle_length        INT NOT NULL,
  academic_year_id    UUID,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  description         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sch_rotation_cycles_name_uq UNIQUE (school_id, name),
  CONSTRAINT sch_rotation_cycles_length_chk CHECK (cycle_length >= 1 AND cycle_length <= 14)
);

CREATE INDEX IF NOT EXISTS sch_rotation_cycles_school_active_idx
  ON sch_rotation_cycles(school_id) WHERE is_active = true;

COMMENT ON TABLE sch_rotation_cycles IS
  'Per-school rotation cycle definitions. cycle_length = 2 for A/B week, 6 for 6-day rotation, etc. Bounded 1..14 by sch_rotation_cycles_length_chk.';

COMMENT ON COLUMN sch_rotation_cycles.school_id IS
  'Soft FK to platform.schools(id) per ADR-001 and ADR-020.';

COMMENT ON COLUMN sch_rotation_cycles.academic_year_id IS
  'Soft FK to sis_academic_years(id) per ADR-001 and ADR-020. NULL means the cycle is academic-year-independent (rare).';


CREATE TABLE IF NOT EXISTS sch_rotation_calendar (
  id                  UUID PRIMARY KEY,
  rotation_cycle_id   UUID NOT NULL REFERENCES sch_rotation_cycles(id) ON DELETE CASCADE,
  calendar_date       DATE NOT NULL,
  rotation_day        INT NOT NULL,
  is_school_day       BOOLEAN NOT NULL DEFAULT true,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sch_rotation_calendar_date_uq UNIQUE (rotation_cycle_id, calendar_date),
  CONSTRAINT sch_rotation_calendar_day_chk CHECK (rotation_day >= 1 AND rotation_day <= 14)
);

CREATE INDEX IF NOT EXISTS sch_rotation_calendar_cycle_date_idx
  ON sch_rotation_calendar(rotation_cycle_id, calendar_date);

CREATE INDEX IF NOT EXISTS sch_rotation_calendar_school_day_idx
  ON sch_rotation_calendar(rotation_cycle_id, calendar_date) WHERE is_school_day = true;

COMMENT ON TABLE sch_rotation_calendar IS
  'Date to rotation_day mapping. Admin-maintained and adjusted for closures via the is_school_day flag. UNIQUE(rotation_cycle_id calendar_date).';

COMMENT ON COLUMN sch_rotation_calendar.rotation_day IS
  '1..N where N is the parent cycle_length. Bounded 1..14 by the CHECK plus app validation at insert time.';


CREATE TABLE IF NOT EXISTS sch_scheduling_constraints (
  id                  UUID PRIMARY KEY,
  school_id           UUID NOT NULL,
  academic_year_id    UUID,
  name                TEXT NOT NULL,
  hard_constraints    JSONB NOT NULL DEFAULT '[]'::jsonb,
  soft_constraints    JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  description         TEXT,
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sch_scheduling_constraints_name_uq UNIQUE (school_id, academic_year_id, name),
  CONSTRAINT sch_scheduling_constraints_hard_chk CHECK (jsonb_typeof(hard_constraints) = 'array'),
  CONSTRAINT sch_scheduling_constraints_soft_chk CHECK (jsonb_typeof(soft_constraints) = 'array')
);

CREATE INDEX IF NOT EXISTS sch_scheduling_constraints_school_active_idx
  ON sch_scheduling_constraints(school_id) WHERE is_active = true;

COMMENT ON TABLE sch_scheduling_constraints IS
  'Constraint profile for the schedule generator. hard_constraints carries H1..H5 (teacher no double-book, room no double-book, student no concurrency, class fits room capacity, cross-school max periods). soft_constraints carries S1..S5 with weights (consecutive period avoidance, teacher preferences, student free period minimisation, etc) per ADR-053. UNIQUE(school_id academic_year_id name).';

COMMENT ON COLUMN sch_scheduling_constraints.created_by IS
  'Soft FK to platform.platform_users(id) per ADR-001 and ADR-020. Audit-only.';


CREATE TABLE IF NOT EXISTS sch_student_subject_choices (
  id                  UUID PRIMARY KEY,
  student_id          UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  academic_year_id    UUID NOT NULL,
  course_id           UUID NOT NULL,
  preference_rank     INT,
  is_required         BOOLEAN NOT NULL DEFAULT false,
  notes               TEXT,
  submitted_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sch_student_subject_choices_uq UNIQUE (student_id, academic_year_id, course_id),
  CONSTRAINT sch_student_subject_choices_rank_chk CHECK (
    preference_rank IS NULL OR (preference_rank >= 1 AND preference_rank <= 20)
  )
);

CREATE INDEX IF NOT EXISTS sch_student_subject_choices_year_course_idx
  ON sch_student_subject_choices(academic_year_id, course_id);

CREATE INDEX IF NOT EXISTS sch_student_subject_choices_student_year_idx
  ON sch_student_subject_choices(student_id, academic_year_id);

COMMENT ON TABLE sch_student_subject_choices IS
  'Demand input for the schedule solver. Students submit during an open sch_subject_choice_windows row. The solver aggregates this table into a per-course demand count when assembling its input payload. UNIQUE(student_id academic_year_id course_id) caps one row per (student year course).';

COMMENT ON COLUMN sch_student_subject_choices.academic_year_id IS
  'Soft FK to sis_academic_years(id) per ADR-001 and ADR-020.';

COMMENT ON COLUMN sch_student_subject_choices.course_id IS
  'Soft FK to sis_courses(id) per ADR-001 and ADR-020.';

COMMENT ON COLUMN sch_student_subject_choices.preference_rank IS
  'Optional 1..20 ordinal preference. NULL means unranked (submitted but no preference order — common for required courses).';


CREATE TABLE IF NOT EXISTS sch_scheduling_requests (
  id                            UUID PRIMARY KEY,
  school_id                     UUID NOT NULL,
  academic_year_id              UUID,
  constraint_id                 UUID NOT NULL REFERENCES sch_scheduling_constraints(id),
  section_count_at_submission   INT NOT NULL,
  solver_algorithm              TEXT NOT NULL,
  status                        TEXT NOT NULL DEFAULT 'QUEUED',
  requested_by                  UUID NOT NULL,
  candidates_generated          INT,
  queued_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at                    TIMESTAMPTZ,
  completed_at                  TIMESTAMPTZ,
  error_message                 TEXT,
  solver_payload                JSONB,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sch_scheduling_requests_section_chk CHECK (section_count_at_submission >= 0),
  CONSTRAINT sch_scheduling_requests_algo_chk CHECK (
    solver_algorithm IN ('CP_SAT','HEURISTIC')
  ),
  CONSTRAINT sch_scheduling_requests_status_chk CHECK (
    status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')
  ),
  CONSTRAINT sch_scheduling_requests_lifecycle_chk CHECK (
    (status = 'QUEUED' AND started_at IS NULL AND completed_at IS NULL)
    OR (status = 'RUNNING' AND started_at IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('COMPLETED','FAILED') AND started_at IS NOT NULL AND completed_at IS NOT NULL)
    OR (status = 'CANCELLED' AND completed_at IS NOT NULL)
  ),
  CONSTRAINT sch_scheduling_requests_algo_threshold_chk CHECK (
    (solver_algorithm = 'CP_SAT' AND section_count_at_submission <= 300)
    OR (solver_algorithm = 'HEURISTIC' AND section_count_at_submission > 300)
    OR (solver_algorithm = 'HEURISTIC' AND section_count_at_submission <= 300)
  )
);

CREATE INDEX IF NOT EXISTS sch_scheduling_requests_school_status_idx
  ON sch_scheduling_requests(school_id, status);

CREATE INDEX IF NOT EXISTS sch_scheduling_requests_queued_idx
  ON sch_scheduling_requests(school_id, queued_at DESC);

COMMENT ON TABLE sch_scheduling_requests IS
  'Solver invocation row. ADR-060 selects solver_algorithm — CP_SAT when section_count_at_submission less-than-or-equal 300, HEURISTIC when greater than 300. HEURISTIC is also allowed below 300 as a manual override for fast iteration. 5-value status with multi-column lifecycle_chk lockstep. Emits sch.generation.completed AFTER tx commit when status flips to COMPLETED.';

COMMENT ON COLUMN sch_scheduling_requests.requested_by IS
  'Soft FK to platform.platform_users(id) per ADR-001 and ADR-020. Audit-only.';

COMMENT ON COLUMN sch_scheduling_requests.solver_payload IS
  'JSONB snapshot of the input payload assembled for the external Scheduling Solver service. Stored for reproducibility and dispute resolution. Drops out of normal queries — pull on demand via /scheduling/requests/:id.';


CREATE TABLE IF NOT EXISTS sch_scheduling_candidates (
  id                          UUID PRIMARY KEY,
  request_id                  UUID NOT NULL REFERENCES sch_scheduling_requests(id) ON DELETE CASCADE,
  candidate_name              TEXT,
  solver_seed                 TEXT,
  total_slots                 INT NOT NULL DEFAULT 0,
  total_clashes               INT NOT NULL DEFAULT 0,
  all_constraints_satisfied   BOOLEAN NOT NULL DEFAULT false,
  constraint_violations       JSONB NOT NULL DEFAULT '[]'::jsonb,
  soft_constraint_score       NUMERIC(8,2),
  review_status               TEXT NOT NULL DEFAULT 'PENDING',
  reviewed_by                 UUID,
  reviewed_at                 TIMESTAMPTZ,
  review_notes                TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sch_scheduling_candidates_review_chk CHECK (
    review_status IN ('PENDING','APPROVED','REJECTED','MODIFIED')
  ),
  CONSTRAINT sch_scheduling_candidates_counts_chk CHECK (
    total_slots >= 0 AND total_clashes >= 0
  ),
  CONSTRAINT sch_scheduling_candidates_violations_chk CHECK (
    jsonb_typeof(constraint_violations) = 'array'
  ),
  CONSTRAINT sch_scheduling_candidates_reviewed_chk CHECK (
    (review_status = 'PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (review_status IN ('APPROVED','REJECTED','MODIFIED') AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS sch_scheduling_candidates_request_idx
  ON sch_scheduling_candidates(request_id, review_status);

COMMENT ON TABLE sch_scheduling_candidates IS
  'Solver-produced candidate solutions for a scheduling request. The promotion lifecycle (PENDING then REVIEWED then APPROVED then ACTIVE) is service-layer — schema only enforces the 4-value review_status CHECK. On APPROVED the SchedulingActivationWorker promotes the candidate slots to sch_timetable_slots but only when total_clashes = 0 AND every linked sch_scheduling_candidate_slots row has has_clash = false.';

COMMENT ON COLUMN sch_scheduling_candidates.solver_seed IS
  'Reproducibility seed for HEURISTIC runs. NULL for CP_SAT (deterministic given identical input). Audit-only — re-running with the same seed plus input plus version yields the same candidate.';

COMMENT ON COLUMN sch_scheduling_candidates.reviewed_by IS
  'Soft FK to platform.platform_users(id) per ADR-001 and ADR-020. Audit-only.';


CREATE TABLE IF NOT EXISTS sch_scheduling_candidate_slots (
  id                  UUID PRIMARY KEY,
  candidate_id        UUID NOT NULL REFERENCES sch_scheduling_candidates(id) ON DELETE CASCADE,
  class_id            UUID,
  teacher_id          UUID,
  room_id             UUID,
  period_id           UUID,
  day_of_week         SMALLINT,
  rotation_day        SMALLINT,
  has_clash           BOOLEAN NOT NULL DEFAULT false,
  clash_description   TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sch_scheduling_candidate_slots_dow_chk CHECK (
    day_of_week IS NULL OR (day_of_week >= 0 AND day_of_week <= 6)
  ),
  CONSTRAINT sch_scheduling_candidate_slots_rot_chk CHECK (
    rotation_day IS NULL OR (rotation_day >= 1 AND rotation_day <= 14)
  ),
  CONSTRAINT sch_scheduling_candidate_slots_clash_chk CHECK (
    (has_clash = false AND clash_description IS NULL)
    OR (has_clash = true AND clash_description IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS sch_scheduling_candidate_slots_candidate_idx
  ON sch_scheduling_candidate_slots(candidate_id);

CREATE INDEX IF NOT EXISTS sch_scheduling_candidate_slots_clash_idx
  ON sch_scheduling_candidate_slots(candidate_id) WHERE has_clash = true;

COMMENT ON TABLE sch_scheduling_candidate_slots IS
  'Per-candidate proposed slot rows. On APPROVED the SchedulingActivationWorker creates a matching sch_timetable_slots entry for every row with has_clash=false. Rows with has_clash=true must be resolved (clash dismissed or slot edited) before the candidate can be activated — the activation worker refuses to promote a candidate that still carries any has_clash=true row.';

COMMENT ON COLUMN sch_scheduling_candidate_slots.class_id IS
  'Soft FK to sis_classes(id) per ADR-001 and ADR-020. Nullable because heuristic exploration may emit placeholder slots before class assignment.';

COMMENT ON COLUMN sch_scheduling_candidate_slots.teacher_id IS
  'Soft FK to hr_employees(id) per ADR-001 and ADR-020. Nullable.';

COMMENT ON COLUMN sch_scheduling_candidate_slots.room_id IS
  'Soft FK to sch_rooms(id) per ADR-001 and ADR-020. Nullable.';

COMMENT ON COLUMN sch_scheduling_candidate_slots.period_id IS
  'Soft FK to sch_periods(id) per ADR-001 and ADR-020. Nullable.';

COMMENT ON CONSTRAINT sch_scheduling_candidate_slots_clash_chk ON sch_scheduling_candidate_slots IS
  'has_clash=true requires clash_description populated. has_clash=false requires clash_description NULL. Multi-column lockstep ensures every flagged clash carries an explanation for the admin review UI.';


CREATE TABLE IF NOT EXISTS sch_scheduling_activation_log (
  id              UUID PRIMARY KEY,
  candidate_id    UUID NOT NULL REFERENCES sch_scheduling_candidates(id) ON DELETE CASCADE,
  slots_promoted  INT NOT NULL DEFAULT 0,
  slots_skipped   INT NOT NULL DEFAULT 0,
  activated_by    UUID NOT NULL,
  activated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sch_scheduling_activation_log_counts_chk CHECK (
    slots_promoted >= 0 AND slots_skipped >= 0
  )
);

CREATE INDEX IF NOT EXISTS sch_scheduling_activation_log_candidate_idx
  ON sch_scheduling_activation_log(candidate_id);

CREATE INDEX IF NOT EXISTS sch_scheduling_activation_log_activated_idx
  ON sch_scheduling_activation_log(activated_at DESC);

COMMENT ON TABLE sch_scheduling_activation_log IS
  'Append-only audit of every candidate promotion to sch_timetable_slots. slots_promoted is the count of successful inserts. slots_skipped is the count of candidate slot rows the activation worker passed over (NULL ids placeholder slots etc).';

COMMENT ON COLUMN sch_scheduling_activation_log.activated_by IS
  'Soft FK to platform.platform_users(id) per ADR-001 and ADR-020.';


CREATE TABLE IF NOT EXISTS sch_subject_choice_windows (
  id                    UUID PRIMARY KEY,
  school_id             UUID NOT NULL,
  academic_year_id      UUID,
  name                  TEXT,
  opens_at              TIMESTAMPTZ NOT NULL,
  closes_at             TIMESTAMPTZ NOT NULL,
  target_grade_levels   TEXT[],
  is_active             BOOLEAN NOT NULL DEFAULT true,
  description           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sch_subject_choice_windows_uq UNIQUE (school_id, academic_year_id),
  CONSTRAINT sch_subject_choice_windows_window_chk CHECK (closes_at > opens_at)
);

CREATE INDEX IF NOT EXISTS sch_subject_choice_windows_school_active_idx
  ON sch_subject_choice_windows(school_id) WHERE is_active = true;

COMMENT ON TABLE sch_subject_choice_windows IS
  'Per-school per-academic-year window controlling when students can submit subject choices. target_grade_levels TEXT[] restricts the window to specific grade labels (e.g. {9 10 11 12}). Empty array or NULL means open to every grade.';

COMMENT ON COLUMN sch_subject_choice_windows.academic_year_id IS
  'Soft FK to sis_academic_years(id) per ADR-001 and ADR-020. NULL means evergreen (rare).';


/*
 * ALTER sch_periods — add rotation_day column.
 *
 * Idempotent via ADD COLUMN IF NOT EXISTS. The column is unconstrained
 * and nullable so the existing Cycle 5 seed plus all in-flight period
 * rows continue to work. When rotation_day is populated the
 * application validates 1..N where N is the matching rotation cycle's
 * cycle_length.
 */
ALTER TABLE sch_periods ADD COLUMN IF NOT EXISTS rotation_day SMALLINT;

COMMENT ON COLUMN sch_periods.rotation_day IS
  'Optional rotation day index (1..N where N is the parent cycle length). NULL means the period applies on every rotation day (the legacy shape). Validated at the application layer when the period links to a rotation cycle.';
