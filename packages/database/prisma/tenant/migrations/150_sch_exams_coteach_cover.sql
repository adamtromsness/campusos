/*
 * 150_sch_exams_coteach_cover.sql — Phase 2 Cycle 17 sub-cycle b (P2-17b).
 *
 * M22 Scheduling Advanced — final 10 of 20 tables. Closes Wave C
 * (Operational Depth).
 *
 *   sch_exam_sessions                Exam scheduling root. One row per
 *                                    (school exam_date subject) exam
 *                                    instance. Carries the global
 *                                    extra_time_minutes (a venue-level
 *                                    extension applied to every
 *                                    student). Per-student
 *                                    accommodations live on the seating
 *                                    row.
 *   sch_exam_session_rooms           Junction (session room) replacing
 *                                    the legacy room_ids ARRAY. Per-
 *                                    room capacity allows a single
 *                                    session to span a main hall plus
 *                                    one or more accommodation rooms.
 *                                    UNIQUE(session_id room_id). Room
 *                                    overlap with sch_timetable_slots
 *                                    is checked at the service layer
 *                                    via tstzrange (the application
 *                                    builds the exam window from
 *                                    exam_date plus start_time and
 *                                    end_time and compares against
 *                                    active timetable slots that share
 *                                    the room and the period clock-
 *                                    time on the exam date weekday).
 *   sch_exam_seatings                Per-student seat allocation. Four
 *                                    per-row accommodation columns
 *                                    (extra_time_minutes separate_room
 *                                    reader_required scribe_required)
 *                                    are auto-populated from
 *                                    sis_student_active_accommodations
 *                                    by the ExamSchedulingService at
 *                                    seat assignment. The mapping uses
 *                                    accommodation_type string match
 *                                    (EXTENDED_TIME plus
 *                                    SEPARATE_LOCATION plus READ_ALOUD
 *                                    plus SCRIBE). UNIQUE(session_id
 *                                    student_id).
 *   sch_exam_invigilator_assignments Per-(session room invigilator)
 *                                    assignment. UNIQUE(session_id
 *                                    room_id invigilator_id). is_lead
 *                                    flag identifies the chief
 *                                    invigilator (one per room — not
 *                                    schema-enforced because some
 *                                    schools rotate lead during long
 *                                    exams).
 *   sch_coteaching_arrangements      Per-(slot secondary_teacher) co-
 *                                    teaching pairing. 5-value
 *                                    teaching_model CHECK
 *                                    (TEAM_TEACHING
 *                                    ONE_TEACH_ONE_SUPPORT
 *                                    STATION_ROTATION
 *                                    PARALLEL_TEACHING
 *                                    ALTERNATIVE_TEACHING).
 *                                    UNIQUE(timetable_slot_id
 *                                    secondary_teacher_id). The
 *                                    keystone — the schema EXCLUSION
 *                                    on sch_timetable_slots
 *                                    (teacher_id period_id daterange)
 *                                    only catches the primary teacher.
 *                                    A secondary teacher who appears
 *                                    here gets the double-booking
 *                                    relaxed at the service layer
 *                                    (CoTeachingService.assertNoConflicts
 *                                    explicitly skips the secondary
 *                                    teacher when validating against
 *                                    the matching slot). Primary
 *                                    teacher conflicts are still
 *                                    caught by the existing schema-
 *                                    side EXCLUSION.
 *   sch_pull_out_interventions       Per-(student regular_slot)
 *                                    intervention scheduling. 4-value
 *                                    frequency CHECK (WEEKLY
 *                                    FORTNIGHTLY DAILY CUSTOM).
 *                                    days_of_week SMALLINT[] carries
 *                                    the intervention weekdays for
 *                                    CUSTOM frequency. The
 *                                    PullOutService pre-marks
 *                                    attendance as PULL_OUT for the
 *                                    student on the regular_slot dates
 *                                    that match the intervention
 *                                    cadence — extends the existing
 *                                    sis_attendance_records_status_chk
 *                                    via DROP plus ADD at the bottom
 *                                    of this migration.
 *   sch_cross_school_staff_assignments
 *                                    Visiting staff assignments
 *                                    between schools. Carries both
 *                                    person_id (iam_person) and
 *                                    home_employee_id (hr_employees in
 *                                    home school). The keystone
 *                                    EXCLUSION uses person_id WITH =
 *                                    and the assignment daterange
 *                                    WITH && so the same iam_person
 *                                    cannot hold overlapping cross-
 *                                    school assignments. The visiting
 *                                    tenant maintains its own
 *                                    sch_timetable_slots EXCLUSION
 *                                    (teacher_id is the visiting
 *                                    school's hr_employees row) but
 *                                    that cannot detect a clash
 *                                    against the home school because
 *                                    tenants are schema-isolated. The
 *                                    person-level EXCLUSION here
 *                                    catches the human-level double-
 *                                    booking on the visiting side at
 *                                    least (one person cannot be
 *                                    assigned to two visiting schools
 *                                    in overlapping windows).
 *                                    UNIQUE(visiting_school_id
 *                                    person_id effective_from).
 *   sch_cover_arrangements           Per-(school absent_teacher
 *                                    cover_date) higher-level
 *                                    arrangement grouping every class
 *                                    the absent teacher would have
 *                                    taught that day. 5-value
 *                                    cover_type CHECK
 *                                    (SUBSTITUTE_REPLACEMENT
 *                                    INTERNAL_COVER CLASS_MERGE
 *                                    CLASS_SPLIT SELF_STUDY). 3-value
 *                                    status CHECK (PLANNED ACTIVE
 *                                    COMPLETED) with multi-column
 *                                    status_chk that COMPLETED
 *                                    requires completed_at not null.
 *                                    sub_assignment_id is a soft FK
 *                                    to sub_assignments from P2-9
 *                                    (the link is informational —
 *                                    cover can be created even when
 *                                    no marketplace assignment yet
 *                                    exists). Distinct from the
 *                                    Cycle 5 sch_coverage_requests
 *                                    table — that table is per-(slot
 *                                    date) granular and is the
 *                                    CoverageConsumer write target.
 *                                    This table is the per-day
 *                                    coordination layer the cover
 *                                    coordinator works from.
 *   sch_cover_arrangement_classes    Junction (arrangement class slot)
 *                                    with 5-value disposition CHECK
 *                                    (COVERED_BY_SUB MERGED_INTO
 *                                    SPLIT_TO SELF_STUDY CANCELLED).
 *                                    destination_room_id and
 *                                    supervising_teacher_id capture
 *                                    where students go and who
 *                                    watches them. UNIQUE(arrangement
 *                                    affected_slot).
 *   sch_cover_split_students         Junction (arrangement_class
 *                                    student) for SPLIT_TO
 *                                    dispositions — which student
 *                                    goes to which split group.
 *                                    UNIQUE(arrangement_class_id
 *                                    student_id). destination_class_
 *                                    label is a free-text marker
 *                                    (e.g. Group A Group B Room 12)
 *                                    so the cover coordinator can
 *                                    label split groups without
 *                                    pre-defining them in another
 *                                    table.
 *
 * Cross-cycle integration:
 *   - sch_exam_sessions.subject_id is a soft FK to sis_courses per
 *     ADR-001 and ADR-020.
 *   - sch_exam_session_rooms.session_id is a DB-enforced FK to
 *     sch_exam_sessions with ON DELETE CASCADE — rooms are part of
 *     the exam definition.
 *   - sch_exam_session_rooms.room_id is a DB-enforced FK to sch_rooms.
 *   - sch_exam_seatings.session_id is a DB-enforced FK to
 *     sch_exam_sessions with ON DELETE CASCADE.
 *   - sch_exam_seatings.student_id is a DB-enforced FK to sis_students
 *     with ON DELETE CASCADE.
 *   - sch_exam_seatings.room_id is a DB-enforced FK to sch_rooms.
 *   - sch_exam_invigilator_assignments.session_id is a DB-enforced FK
 *     to sch_exam_sessions with ON DELETE CASCADE.
 *   - sch_exam_invigilator_assignments.room_id is a DB-enforced FK to
 *     sch_rooms.
 *   - sch_exam_invigilator_assignments.invigilator_id is a DB-enforced
 *     FK to hr_employees.
 *   - sch_coteaching_arrangements.timetable_slot_id is a DB-enforced
 *     FK to sch_timetable_slots with ON DELETE CASCADE.
 *   - sch_coteaching_arrangements.primary_teacher_id is a DB-enforced
 *     FK to hr_employees.
 *   - sch_coteaching_arrangements.secondary_teacher_id is a DB-enforced
 *     FK to hr_employees.
 *   - sch_pull_out_interventions.student_id is a DB-enforced FK to
 *     sis_students with ON DELETE CASCADE.
 *   - sch_pull_out_interventions.regular_slot_id is a DB-enforced FK
 *     to sch_timetable_slots.
 *   - sch_pull_out_interventions.intervention_provider is a DB-enforced
 *     FK to hr_employees.
 *   - sch_cross_school_staff_assignments.person_id is a soft FK to
 *     platform.iam_person per ADR-001 and ADR-020.
 *   - sch_cross_school_staff_assignments.home_employee_id is a DB-
 *     enforced FK to hr_employees.
 *   - sch_cross_school_staff_assignments.home_school_id and
 *     visiting_school_id are soft FKs to platform.schools per
 *     ADR-001 and ADR-020.
 *   - sch_cover_arrangements.absent_teacher_id is a DB-enforced FK to
 *     hr_employees.
 *   - sch_cover_arrangements.covering_teacher_id is a DB-enforced FK
 *     to hr_employees (nullable).
 *   - sch_cover_arrangements.sub_assignment_id is a soft FK to
 *     sub_assignments (intra-tenant) per ADR-001 and ADR-020 — kept
 *     soft because cover arrangements can be planned ahead of any
 *     marketplace sub assignment existing.
 *   - sch_cover_arrangement_classes.arrangement_id is a DB-enforced FK
 *     to sch_cover_arrangements with ON DELETE CASCADE.
 *   - sch_cover_arrangement_classes.affected_class_id is a DB-enforced
 *     FK to sis_classes.
 *   - sch_cover_arrangement_classes.affected_slot_id is a DB-enforced
 *     FK to sch_timetable_slots.
 *   - sch_cover_split_students.arrangement_class_id is a DB-enforced
 *     FK to sch_cover_arrangement_classes with ON DELETE CASCADE.
 *   - sch_cover_split_students.student_id is a DB-enforced FK to
 *     sis_students with ON DELETE CASCADE.
 *
 * ALTER sis_attendance_records_status_chk — extend the 5-value status
 * enum (PRESENT ABSENT TARDY EARLY_DEPARTURE EXCUSED) with PULL_OUT.
 * Splitter-safe DROP plus ADD pattern (matches the
 * 010_msg_queue_processing_state and 056_enr_application_stages_scores
 * precedents). Partitioned parents cascade the new CHECK to every
 * partition automatically.
 *
 * Splitter discipline — no semicolons inside string literals default
 * expressions COMMENT bodies CHECK predicates or block comments. The
 * splitter cuts on every semicolon regardless of quoting context.
 * Idempotent — safe to re-run.
 */

CREATE EXTENSION IF NOT EXISTS btree_gist;


CREATE TABLE IF NOT EXISTS sch_exam_sessions (
  id                    UUID PRIMARY KEY,
  school_id             UUID NOT NULL,
  exam_name             TEXT NOT NULL,
  subject_id            UUID,
  exam_date             DATE NOT NULL,
  start_time            TIME NOT NULL,
  end_time              TIME NOT NULL,
  duration_minutes      INT NOT NULL,
  extra_time_minutes    INT NOT NULL DEFAULT 0,
  notes                 TEXT,
  created_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sch_exam_sessions_window_chk CHECK (end_time > start_time),
  CONSTRAINT sch_exam_sessions_duration_chk CHECK (duration_minutes > 0),
  CONSTRAINT sch_exam_sessions_extra_chk CHECK (extra_time_minutes >= 0)
);

CREATE INDEX IF NOT EXISTS sch_exam_sessions_school_date_idx
  ON sch_exam_sessions(school_id, exam_date);

CREATE INDEX IF NOT EXISTS sch_exam_sessions_subject_idx
  ON sch_exam_sessions(subject_id) WHERE subject_id IS NOT NULL;

COMMENT ON TABLE sch_exam_sessions IS
  'One row per exam instance. exam_date plus start_time plus end_time define the wall-clock window. extra_time_minutes is the venue-level extension applied to every student (use for the whole exam block running long). Per-student accommodations live on sch_exam_seatings.';

COMMENT ON COLUMN sch_exam_sessions.school_id IS
  'Soft FK to platform.schools(id) per ADR-001 and ADR-020.';

COMMENT ON COLUMN sch_exam_sessions.subject_id IS
  'Soft FK to sis_courses(id) per ADR-001 and ADR-020. Nullable because an exam may not map to a single course (e.g. unit assessment crossing multiple courses).';

COMMENT ON COLUMN sch_exam_sessions.created_by IS
  'Soft FK to platform.platform_users(id) per ADR-001 and ADR-020. Audit-only.';


CREATE TABLE IF NOT EXISTS sch_exam_session_rooms (
  id              UUID PRIMARY KEY,
  session_id      UUID NOT NULL REFERENCES sch_exam_sessions(id) ON DELETE CASCADE,
  room_id         UUID NOT NULL REFERENCES sch_rooms(id),
  capacity        INT NOT NULL,
  is_main_room    BOOLEAN NOT NULL DEFAULT true,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sch_exam_session_rooms_uq UNIQUE (session_id, room_id),
  CONSTRAINT sch_exam_session_rooms_capacity_chk CHECK (capacity > 0)
);

CREATE INDEX IF NOT EXISTS sch_exam_session_rooms_session_idx
  ON sch_exam_session_rooms(session_id);

CREATE INDEX IF NOT EXISTS sch_exam_session_rooms_room_idx
  ON sch_exam_session_rooms(room_id);

COMMENT ON TABLE sch_exam_session_rooms IS
  'Junction (session room) replacing the legacy room_ids ARRAY on the original sch_exam_sessions design. capacity is the per-room seat cap for this exam (smaller than the rooms physical capacity when honouring spacing rules). is_main_room=true marks the primary venue. Additional rooms (is_main_room=false) are accommodation rooms — typically smaller and used by students with separate_room=true. Room overlap detection against sch_timetable_slots is service-layer (ExamSchedulingService.findRoomConflicts) using tstzrange overlap on the exam window.';


CREATE TABLE IF NOT EXISTS sch_exam_seatings (
  id                      UUID PRIMARY KEY,
  session_id              UUID NOT NULL REFERENCES sch_exam_sessions(id) ON DELETE CASCADE,
  student_id              UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  room_id                 UUID NOT NULL REFERENCES sch_rooms(id),
  seat_number             TEXT,
  extra_time_minutes      INT NOT NULL DEFAULT 0,
  separate_room           BOOLEAN NOT NULL DEFAULT false,
  reader_required         BOOLEAN NOT NULL DEFAULT false,
  scribe_required         BOOLEAN NOT NULL DEFAULT false,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sch_exam_seatings_uq UNIQUE (session_id, student_id),
  CONSTRAINT sch_exam_seatings_extra_chk CHECK (extra_time_minutes >= 0)
);

CREATE INDEX IF NOT EXISTS sch_exam_seatings_session_idx
  ON sch_exam_seatings(session_id);

CREATE INDEX IF NOT EXISTS sch_exam_seatings_student_idx
  ON sch_exam_seatings(student_id);

CREATE INDEX IF NOT EXISTS sch_exam_seatings_accommodations_idx
  ON sch_exam_seatings(session_id)
  WHERE extra_time_minutes > 0 OR separate_room = true OR reader_required = true OR scribe_required = true;

COMMENT ON TABLE sch_exam_seatings IS
  'Per-student seat allocation. The four accommodation flags (extra_time_minutes separate_room reader_required scribe_required) are auto-populated by the ExamSchedulingService at seat assignment from sis_student_active_accommodations matching the accommodation_type strings EXTENDED_TIME (extra_time_minutes set to 25 percent default), SEPARATE_LOCATION (separate_room=true), READ_ALOUD (reader_required=true), SCRIBE (scribe_required=true). Admin can override the auto-populated values on the seating row. UNIQUE(session student) caps at one seating per (session student).';

COMMENT ON COLUMN sch_exam_seatings.seat_number IS
  'Free-form seat label (e.g. A12 R3-S5). NULL is acceptable for small exams where seats are not numbered.';

COMMENT ON COLUMN sch_exam_seatings.extra_time_minutes IS
  'Per-student extension on top of sch_exam_sessions.extra_time_minutes (which is the venue-level extension). For EXTENDED_TIME accommodation the service defaults to ceil(duration_minutes * 0.25) on auto-population.';


CREATE TABLE IF NOT EXISTS sch_exam_invigilator_assignments (
  id                  UUID PRIMARY KEY,
  session_id          UUID NOT NULL REFERENCES sch_exam_sessions(id) ON DELETE CASCADE,
  room_id             UUID NOT NULL REFERENCES sch_rooms(id),
  invigilator_id      UUID NOT NULL REFERENCES hr_employees(id),
  is_lead             BOOLEAN NOT NULL DEFAULT false,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sch_exam_invigilator_assignments_uq UNIQUE (session_id, room_id, invigilator_id)
);

CREATE INDEX IF NOT EXISTS sch_exam_invigilator_assignments_session_idx
  ON sch_exam_invigilator_assignments(session_id);

CREATE INDEX IF NOT EXISTS sch_exam_invigilator_assignments_invigilator_idx
  ON sch_exam_invigilator_assignments(invigilator_id);

COMMENT ON TABLE sch_exam_invigilator_assignments IS
  'Per-(session room invigilator) assignment. is_lead identifies the chief invigilator for the room — not schema-enforced as unique per room because some schools rotate lead during long exams.';


CREATE TABLE IF NOT EXISTS sch_coteaching_arrangements (
  id                      UUID PRIMARY KEY,
  timetable_slot_id       UUID NOT NULL REFERENCES sch_timetable_slots(id) ON DELETE CASCADE,
  primary_teacher_id      UUID NOT NULL REFERENCES hr_employees(id),
  secondary_teacher_id    UUID NOT NULL REFERENCES hr_employees(id),
  teaching_model          TEXT NOT NULL,
  effective_from          DATE,
  effective_to            DATE,
  notes                   TEXT,
  created_by              UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sch_coteaching_arrangements_uq UNIQUE (timetable_slot_id, secondary_teacher_id),
  CONSTRAINT sch_coteaching_arrangements_distinct_chk CHECK (primary_teacher_id <> secondary_teacher_id),
  CONSTRAINT sch_coteaching_arrangements_model_chk CHECK (
    teaching_model IN ('TEAM_TEACHING','ONE_TEACH_ONE_SUPPORT','STATION_ROTATION','PARALLEL_TEACHING','ALTERNATIVE_TEACHING')
  ),
  CONSTRAINT sch_coteaching_arrangements_dates_chk CHECK (
    effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from
  )
);

CREATE INDEX IF NOT EXISTS sch_coteaching_arrangements_slot_idx
  ON sch_coteaching_arrangements(timetable_slot_id);

CREATE INDEX IF NOT EXISTS sch_coteaching_arrangements_secondary_idx
  ON sch_coteaching_arrangements(secondary_teacher_id);

COMMENT ON TABLE sch_coteaching_arrangements IS
  'Co-teaching pairing for a timetable slot. The keystone — sch_timetable_slots carries an EXCLUSION on (teacher_id period_id daterange) catching the primary teachers double-booking. A secondary teacher referenced in this table is exempt at the service layer (CoTeachingService.assertNoConflicts skips the secondary teacher when validating any slot they appear on as secondary). The primary teachers EXCLUSION is unchanged and continues to catch every primary-side conflict.';

COMMENT ON COLUMN sch_coteaching_arrangements.teaching_model IS
  '5-value CHECK. TEAM_TEACHING (both teachers deliver concurrently). ONE_TEACH_ONE_SUPPORT (primary delivers secondary supports). STATION_ROTATION (students rotate between teacher-led stations). PARALLEL_TEACHING (class splits into two teacher-led groups). ALTERNATIVE_TEACHING (primary takes the main group secondary takes a small group for differentiated content).';

COMMENT ON COLUMN sch_coteaching_arrangements.created_by IS
  'Soft FK to platform.platform_users(id) per ADR-001 and ADR-020. Audit-only.';


CREATE TABLE IF NOT EXISTS sch_pull_out_interventions (
  id                          UUID PRIMARY KEY,
  school_id                   UUID NOT NULL,
  student_id                  UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  regular_slot_id             UUID NOT NULL REFERENCES sch_timetable_slots(id),
  intervention_name           TEXT NOT NULL,
  intervention_provider       UUID REFERENCES hr_employees(id),
  intervention_location       TEXT,
  start_date                  DATE NOT NULL,
  end_date                    DATE,
  frequency                   TEXT NOT NULL,
  days_of_week                SMALLINT[],
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sch_pull_out_interventions_frequency_chk CHECK (
    frequency IN ('WEEKLY','FORTNIGHTLY','DAILY','CUSTOM')
  ),
  CONSTRAINT sch_pull_out_interventions_dates_chk CHECK (
    end_date IS NULL OR end_date >= start_date
  ),
  CONSTRAINT sch_pull_out_interventions_dow_chk CHECK (
    days_of_week IS NULL OR (
      array_length(days_of_week, 1) >= 1
      AND array_length(days_of_week, 1) <= 7
    )
  )
);

CREATE INDEX IF NOT EXISTS sch_pull_out_interventions_student_idx
  ON sch_pull_out_interventions(student_id, start_date);

CREATE INDEX IF NOT EXISTS sch_pull_out_interventions_slot_idx
  ON sch_pull_out_interventions(regular_slot_id);

CREATE INDEX IF NOT EXISTS sch_pull_out_interventions_school_active_idx
  ON sch_pull_out_interventions(school_id, end_date) WHERE end_date IS NULL;

CREATE INDEX IF NOT EXISTS sch_pull_out_interventions_school_window_idx
  ON sch_pull_out_interventions(school_id, end_date);

COMMENT ON TABLE sch_pull_out_interventions IS
  'Per-(student regular_slot) intervention scheduling. The PullOutService pre-marks sis_attendance_records as PULL_OUT for the student on the regular_slot dates that match the intervention cadence — extends sis_attendance_records_status_chk via the DROP plus ADD at the bottom of this migration. Distinct from co-teaching — pull-outs remove the student from the regular lesson rather than adjusting the teaching pair.';

COMMENT ON COLUMN sch_pull_out_interventions.school_id IS
  'Soft FK to platform.schools(id) per ADR-001 and ADR-020.';

COMMENT ON COLUMN sch_pull_out_interventions.frequency IS
  '4-value CHECK. WEEKLY (one specific weekday from days_of_week each week). FORTNIGHTLY (one weekday every other week). DAILY (every weekday in the slot range). CUSTOM (every weekday listed in days_of_week — supports patterns like Tuesday plus Thursday).';

COMMENT ON COLUMN sch_pull_out_interventions.days_of_week IS
  'SMALLINT[] with values 0..6 (0=Sunday 6=Saturday matching the EXTRACT(DOW FROM date) convention). Optional for WEEKLY (defaults to the regular_slot weekday) and DAILY (ignored). Required for CUSTOM. The service validates 1..7 entries.';


CREATE TABLE IF NOT EXISTS sch_cross_school_staff_assignments (
  id                          UUID PRIMARY KEY,
  home_school_id              UUID NOT NULL,
  visiting_school_id          UUID NOT NULL,
  person_id                   UUID NOT NULL,
  home_employee_id            UUID NOT NULL REFERENCES hr_employees(id),
  role_at_visiting_school     TEXT NOT NULL,
  effective_from              DATE NOT NULL,
  effective_to                DATE,
  max_periods_per_week        INT,
  approved_by                 UUID,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sch_cross_school_staff_assignments_uq UNIQUE (visiting_school_id, person_id, effective_from),
  CONSTRAINT sch_cross_school_staff_assignments_schools_chk CHECK (home_school_id <> visiting_school_id),
  CONSTRAINT sch_cross_school_staff_assignments_dates_chk CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  ),
  CONSTRAINT sch_cross_school_staff_assignments_periods_chk CHECK (
    max_periods_per_week IS NULL OR max_periods_per_week > 0
  ),
  CONSTRAINT sch_cross_school_staff_assignments_no_overlap EXCLUDE USING gist (
    person_id WITH =,
    daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[)') WITH &&
  )
);

CREATE INDEX IF NOT EXISTS sch_cross_school_staff_assignments_visiting_idx
  ON sch_cross_school_staff_assignments(visiting_school_id, effective_from DESC);

CREATE INDEX IF NOT EXISTS sch_cross_school_staff_assignments_person_idx
  ON sch_cross_school_staff_assignments(person_id);

CREATE INDEX IF NOT EXISTS sch_cross_school_staff_assignments_home_employee_idx
  ON sch_cross_school_staff_assignments(home_employee_id);

COMMENT ON TABLE sch_cross_school_staff_assignments IS
  'Visiting staff assignments between schools. Both schools live in different tenant schemas so sch_timetable_slots EXCLUSION (which is keyed on hr_employees.id) cannot detect a cross-tenant double-booking. The schema EXCLUSION here uses person_id (iam_person) so the same human cannot be assigned to overlapping visiting-school windows. The home tenant maintains the hr_employees row (home_employee_id). The visiting tenant creates its own hr_employees row plus sch_timetable_slots for the visitors lessons (the visit appears as a normal teacher in the visiting timetable). UNIQUE(visiting_school_id person_id effective_from) caps at one assignment per (visiting_school person start_date) pair.';

COMMENT ON COLUMN sch_cross_school_staff_assignments.home_school_id IS
  'Soft FK to platform.schools(id) per ADR-001 and ADR-020.';

COMMENT ON COLUMN sch_cross_school_staff_assignments.visiting_school_id IS
  'Soft FK to platform.schools(id) per ADR-001 and ADR-020.';

COMMENT ON COLUMN sch_cross_school_staff_assignments.person_id IS
  'Soft FK to platform.iam_person(id) per ADR-001 and ADR-020. The keystone — both EXCLUSION constraints and the UNIQUE constraint key on this person-level identifier so the same human cannot hold overlapping cross-school assignments.';

COMMENT ON COLUMN sch_cross_school_staff_assignments.approved_by IS
  'Soft FK to platform.platform_users(id) per ADR-001 and ADR-020. Audit-only.';

COMMENT ON CONSTRAINT sch_cross_school_staff_assignments_no_overlap ON sch_cross_school_staff_assignments IS
  'Person-level EXCLUSION preventing the same iam_person from holding overlapping cross-school assignments in this tenant. SQLSTATE 23P01 on violation. CrossSchoolStaffService translates this to 409 Conflict carrying the overlapping assignment id.';


CREATE TABLE IF NOT EXISTS sch_cover_arrangements (
  id                      UUID PRIMARY KEY,
  school_id               UUID NOT NULL,
  absent_teacher_id       UUID NOT NULL REFERENCES hr_employees(id),
  cover_date              DATE NOT NULL,
  cover_type              TEXT NOT NULL,
  sub_assignment_id       UUID,
  covering_teacher_id     UUID REFERENCES hr_employees(id),
  status                  TEXT NOT NULL DEFAULT 'PLANNED',
  completed_at            TIMESTAMPTZ,
  notes                   TEXT,
  created_by              UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sch_cover_arrangements_type_chk CHECK (
    cover_type IN ('SUBSTITUTE_REPLACEMENT','INTERNAL_COVER','CLASS_MERGE','CLASS_SPLIT','SELF_STUDY')
  ),
  CONSTRAINT sch_cover_arrangements_status_chk CHECK (
    status IN ('PLANNED','ACTIVE','COMPLETED')
  ),
  CONSTRAINT sch_cover_arrangements_completed_chk CHECK (
    (status = 'COMPLETED' AND completed_at IS NOT NULL)
    OR (status IN ('PLANNED','ACTIVE') AND completed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS sch_cover_arrangements_school_date_idx
  ON sch_cover_arrangements(school_id, cover_date, status);

CREATE INDEX IF NOT EXISTS sch_cover_arrangements_absent_teacher_idx
  ON sch_cover_arrangements(absent_teacher_id, cover_date);

CREATE INDEX IF NOT EXISTS sch_cover_arrangements_sub_assignment_idx
  ON sch_cover_arrangements(sub_assignment_id) WHERE sub_assignment_id IS NOT NULL;

COMMENT ON TABLE sch_cover_arrangements IS
  'Higher-level per-(school absent_teacher cover_date) cover coordination row. Groups every class the absent teacher would have taught that day under a single arrangement with a chosen cover_type. Distinct from the Cycle 5 sch_coverage_requests table — that table is per-(slot date) granular and is the CoverageConsumer write target. This table is the per-day coordination layer the cover coordinator works from. The classes affected by the arrangement live in sch_cover_arrangement_classes with per-class disposition.';

COMMENT ON COLUMN sch_cover_arrangements.school_id IS
  'Soft FK to platform.schools(id) per ADR-001 and ADR-020.';

COMMENT ON COLUMN sch_cover_arrangements.cover_type IS
  '5-value CHECK. SUBSTITUTE_REPLACEMENT (an external substitute teacher covers). INTERNAL_COVER (another staff member covers). CLASS_MERGE (the affected class is merged into another class). CLASS_SPLIT (the affected class is split across multiple classes — see sch_cover_split_students). SELF_STUDY (the class works supervised without direct instruction).';

COMMENT ON COLUMN sch_cover_arrangements.sub_assignment_id IS
  'Soft FK to sub_assignments(id) per ADR-001 and ADR-020. Set on SUBSTITUTE_REPLACEMENT cover_type when the marketplace assignment exists. Nullable because cover arrangements can be planned ahead of any sub assignment being created.';

COMMENT ON COLUMN sch_cover_arrangements.created_by IS
  'Soft FK to platform.platform_users(id) per ADR-001 and ADR-020. Audit-only.';


CREATE TABLE IF NOT EXISTS sch_cover_arrangement_classes (
  id                          UUID PRIMARY KEY,
  arrangement_id              UUID NOT NULL REFERENCES sch_cover_arrangements(id) ON DELETE CASCADE,
  affected_class_id           UUID NOT NULL REFERENCES sis_classes(id),
  affected_slot_id            UUID NOT NULL REFERENCES sch_timetable_slots(id),
  disposition                 TEXT NOT NULL,
  destination_room_id         UUID REFERENCES sch_rooms(id),
  supervising_teacher_id      UUID REFERENCES hr_employees(id),
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sch_cover_arrangement_classes_uq UNIQUE (arrangement_id, affected_slot_id),
  CONSTRAINT sch_cover_arrangement_classes_disposition_chk CHECK (
    disposition IN ('COVERED_BY_SUB','MERGED_INTO','SPLIT_TO','SELF_STUDY','CANCELLED')
  )
);

CREATE INDEX IF NOT EXISTS sch_cover_arrangement_classes_arrangement_idx
  ON sch_cover_arrangement_classes(arrangement_id);

CREATE INDEX IF NOT EXISTS sch_cover_arrangement_classes_slot_idx
  ON sch_cover_arrangement_classes(affected_slot_id);

COMMENT ON TABLE sch_cover_arrangement_classes IS
  'Junction (arrangement class slot) carrying per-class disposition. UNIQUE(arrangement_id affected_slot_id) caps at one disposition per (arrangement slot). destination_room_id and supervising_teacher_id are optional — populated based on disposition (e.g. MERGED_INTO sets destination_room_id to the receiving rooms id).';

COMMENT ON COLUMN sch_cover_arrangement_classes.disposition IS
  '5-value CHECK. COVERED_BY_SUB (the substitute teaches this class). MERGED_INTO (students join another class — destination_room_id required). SPLIT_TO (students distributed across multiple classes — see sch_cover_split_students for the per-student assignment). SELF_STUDY (class works supervised). CANCELLED (the class is dropped for the day).';


CREATE TABLE IF NOT EXISTS sch_cover_split_students (
  id                          UUID PRIMARY KEY,
  arrangement_class_id        UUID NOT NULL REFERENCES sch_cover_arrangement_classes(id) ON DELETE CASCADE,
  student_id                  UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  destination_class_label     TEXT,
  destination_room_id         UUID REFERENCES sch_rooms(id),
  supervising_teacher_id      UUID REFERENCES hr_employees(id),
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sch_cover_split_students_uq UNIQUE (arrangement_class_id, student_id)
);

CREATE INDEX IF NOT EXISTS sch_cover_split_students_arrangement_class_idx
  ON sch_cover_split_students(arrangement_class_id);

CREATE INDEX IF NOT EXISTS sch_cover_split_students_student_idx
  ON sch_cover_split_students(student_id);

COMMENT ON TABLE sch_cover_split_students IS
  'Junction (arrangement_class student) for SPLIT_TO dispositions. destination_class_label is a free-text marker (e.g. Group A Group B Room 12 Mrs Patel) so the cover coordinator can label split groups without pre-defining them in another table. destination_room_id and supervising_teacher_id are the optional per-student overrides — usually all students in the same destination_class_label share the same room and supervising teacher but the schema does not force that. UNIQUE(arrangement_class_id student_id) ensures each student appears in exactly one split group per arrangement_class.';


/*
 * ALTER sis_attendance_records_status_chk — extend the 5-value status
 * enum (PRESENT ABSENT TARDY EARLY_DEPARTURE EXCUSED) with PULL_OUT.
 *
 * The Cycle 1 sis_attendance_records table is RANGE-partitioned by
 * school_year. Postgres cascades CHECK constraint changes from the
 * partitioned parent to every partition automatically. The
 * splitter-safe DROP plus ADD pattern is used (matches the
 * 010_msg_queue_processing_state and 056_enr_application_stages_scores
 * precedents).
 *
 * The PullOutService writes attendance rows with status PULL_OUT for
 * a (student regular_slot) pair on the dates that match the
 * intervention cadence. Teachers reading their attendance roster see
 * the PULL_OUT pre-mark and can confirm or escalate (a student who is
 * scheduled for pull-out but turns up to the regular lesson should
 * have their attendance overridden to PRESENT). The status_chk
 * extension is the schema-side belt-and-braces.
 */
ALTER TABLE sis_attendance_records DROP CONSTRAINT IF EXISTS sis_attendance_records_status_chk;
ALTER TABLE sis_attendance_records ADD CONSTRAINT sis_attendance_records_status_chk
  CHECK (status IN ('PRESENT','ABSENT','TARDY','EARLY_DEPARTURE','EXCUSED','PULL_OUT'));

COMMENT ON CONSTRAINT sis_attendance_records_status_chk ON sis_attendance_records IS
  '6-value CHECK extended in P2-17b migration 150 to include PULL_OUT. PULL_OUT means the student is scheduled for a sch_pull_out_interventions session that conflicts with the regular slot — the student is not absent and not excused in the conduct sense but is not present in the regular lesson. Teachers reading the roster see the PULL_OUT pre-mark and confirm or override.';
