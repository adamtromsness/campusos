/* 128_cls_standards_peer
 *
 * Phase 2 Cycle 7 (P2-7) sub-cycle b — Classroom Advanced.
 *
 * Plan reference — docs/campusos-p2c7-classroom-advanced.html Step 3.
 *
 * Plan migration number is 113 but slot 113 is taken
 * (hr_employee_position_salary_scale). Used 128 per the established
 * Cycle 4 onwards convention of using the next available slot when the
 * planned number is occupied.
 *
 * 8 new tables for the M21 .1 standards-based gradebook plus peer review
 * plus formative assessment surface. No external service dependencies.
 * Independently shippable. Extends Cycle 23 cur_standards (or platform
 * cur_standards_platform) via a soft polymorphic FK pattern matching the
 * Cycle 23 cur_unit_standards.standard_id convention.
 *
 *   cls_standard_grades            — Standards-based grading distinct
 *                                    from traditional cls_grades.
 *                                    UNIQUE(student_id, standard_id,
 *                                    class_id) keystone caps each
 *                                    student at one proficiency rating
 *                                    per standard per class. The
 *                                    proficiency_level 5-value CHECK
 *                                    EXCEEDING / MEETING / APPROACHING /
 *                                    BELOW / NOT_ASSESSED captures the
 *                                    standards-based mastery scale.
 *                                    standard_id is a soft polymorphic
 *                                    FK resolving to either tenant
 *                                    cur_standards or platform
 *                                    cur_standards_platform per the
 *                                    Cycle 23 dual-resolution keystone.
 *                                    The Step 4 StandardGradeService
 *                                    validates against both catalogues
 *                                    on every write.
 *   cls_standard_grade_evidence    — Links proficiency ratings to the
 *                                    work that demonstrates them.
 *                                    4-value evidence_type CHECK
 *                                    SUBMISSION / OBSERVATION /
 *                                    ASSESSMENT / TEACHER_NOTE.
 *                                    evidence_ref_id is a soft
 *                                    polymorphic FK whose target depends
 *                                    on evidence_type — SUBMISSION
 *                                    points at cls_submissions,
 *                                    ASSESSMENT at cls_grades, the
 *                                    other two carry NULL with the
 *                                    description column the source of
 *                                    truth. CASCADE on parent standard
 *                                    grade since evidence has no
 *                                    meaning without its rating.
 *   cls_peer_review_assignments    — Per-(assignment) peer review
 *                                    config. UNIQUE(assignment_id) so
 *                                    peer review is opt-in once per
 *                                    assignment. review_type 2-value
 *                                    CHECK RANDOM / TEACHER_ASSIGNED
 *                                    drives the Step 4 RandomAssigner
 *                                    distribution path. is_anonymous
 *                                    flag is the load-bearing flag
 *                                    for the Step 4 anonymisation
 *                                    keystone in cls_peer_reviews
 *                                    reads — when true the reviewer
 *                                    identity is stripped from the
 *                                    response payload returned to
 *                                    the reviewee. rubric_id is
 *                                    nullable — when set, peer
 *                                    reviewers also score using the
 *                                    rubric via cls_rubric_scores.
 *   cls_peer_reviews               — Per-(peer_assignment, reviewer,
 *                                    reviewee_submission) review row.
 *                                    UNIQUE keystone caps each
 *                                    reviewer at one review per
 *                                    submission. 3-state status CHECK
 *                                    ASSIGNED / SUBMITTED /
 *                                    REVIEWED_BY_TEACHER tracks the
 *                                    review lifecycle. overall_rating
 *                                    is a 4-value CHECK EXCELLENT /
 *                                    GOOD / DEVELOPING / NEEDS_WORK
 *                                    or NULL while pending. Multi-
 *                                    column submitted_chk lockstep
 *                                    pins submitted_at to NULL on
 *                                    ASSIGNED and to NOT NULL on
 *                                    SUBMITTED + REVIEWED_BY_TEACHER.
 *                                    Anonymisation is enforced at the
 *                                    service layer not the schema —
 *                                    the row carries reviewer_student_id
 *                                    populated regardless so teachers
 *                                    can audit, but the DTO returned
 *                                    to the reviewee strips the field
 *                                    when parent assignment is
 *                                    is_anonymous=true.
 *   cls_student_observations       — Lighter than report cards — mid-
 *                                    term observations. The plan name
 *                                    cls_student_progress_notes is
 *                                    already taken by Cycle 2 with a
 *                                    different shape (UNIQUE per
 *                                    term, summary-style note). This
 *                                    new table is the observation
 *                                    log — multiple per term with a
 *                                    note_type 3-value CHECK PROGRESS
 *                                    / CONCERN / COMMENDATION
 *                                    categorisation and a separate
 *                                    is_shared_with_parent visibility
 *                                    flag. Both tables coexist and
 *                                    serve different surfaces.
 *                                    Documented as a deviation from
 *                                    the plan name in HANDOFF-P2C7.md.
 *   cls_report_card_subjects       — Snapshot per-(report_card,
 *                                    subject) row mirroring the
 *                                    existing cls_report_card_entries
 *                                    table from Cycle 2 but with the
 *                                    additional teacher_comments and
 *                                    effort_grade columns called for
 *                                    by the plan. course_id is a
 *                                    nullable soft FK to sis_courses
 *                                    so the subject_label can be a
 *                                    free-text snapshot that survives
 *                                    course catalogue changes.
 *   cls_formative_assessments      — Per-(class) quick check for
 *                                    understanding. assessment_type
 *                                    4-value CHECK EXIT_TICKET /
 *                                    POLL / QUICK_CHECK / DO_NOW.
 *                                    questions JSONB is the array of
 *                                    {prompt, response_type, options}
 *                                    shapes consumed by the live
 *                                    student response UI. is_active
 *                                    boolean opens the assessment for
 *                                    student responses — the Step 4
 *                                    PATCH /:id/activate locks the
 *                                    row + flips the flag in one tx.
 *   cls_formative_responses        — Per-(assessment, student) student
 *                                    response. UNIQUE keystone caps
 *                                    each student at one response per
 *                                    assessment. responses JSONB is
 *                                    the keyed map of question_id ->
 *                                    response_value matching the
 *                                    questions array shape on the
 *                                    parent assessment. Real-time
 *                                    classroom check-for-understanding
 *                                    feeds back to the teacher via
 *                                    GET /:id/results aggregate.
 *
 * 11 new intra-tenant FKs (CASCADE x 9 + SET NULL x 1 + NO ACTION x 1).
 * 0 cross-schema FKs. All cross-module refs to platform.iam_person and
 * to hr_employees follow the soft FK convention per ADR-001/020 +
 * ADR-055. The standard_id column on cls_standard_grades is also a
 * soft FK because Cycle 23 standards live in two catalogues — tenant
 * cur_standards plus platform cur_standards_platform — and the column
 * resolves either side at the application layer.
 *
 * Splitter convention — no semicolons inside string literals or block
 * comment headers. Every comment uses periods, em-dashes, "and", or
 * "plus" connectives.
 */

CREATE TABLE IF NOT EXISTS cls_standard_grades (
    id UUID PRIMARY KEY,
    student_id UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
    standard_id UUID NOT NULL,
    class_id UUID NOT NULL REFERENCES sis_classes(id) ON DELETE CASCADE,
    proficiency_level TEXT NOT NULL,
    assessed_by UUID NOT NULL,
    assessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_standard_grades_proficiency_chk
      CHECK (proficiency_level IN ('EXCEEDING','MEETING','APPROACHING','BELOW','NOT_ASSESSED')),
    CONSTRAINT cls_standard_grades_uq
      UNIQUE (student_id, standard_id, class_id)
);

CREATE INDEX IF NOT EXISTS cls_standard_grades_student_idx
  ON cls_standard_grades(student_id);

CREATE INDEX IF NOT EXISTS cls_standard_grades_class_standard_idx
  ON cls_standard_grades(class_id, standard_id);

CREATE INDEX IF NOT EXISTS cls_standard_grades_standard_idx
  ON cls_standard_grades(standard_id);

COMMENT ON TABLE cls_standard_grades IS
  'Standards-based gradebook row. UNIQUE(student_id, standard_id, class_id) caps each student at one proficiency rating per standard per class. Distinct from cls_grades which is the traditional points-based gradebook. The proficiency_level 5-value CHECK captures the mastery scale used in standards-based grading.';

COMMENT ON COLUMN cls_standard_grades.standard_id IS
  'Soft polymorphic FK to either tenant cur_standards(id) or platform.cur_standards_platform(id) per the Cycle 23 dual-resolution keystone. Validated at the application layer in StandardGradeService.';

COMMENT ON COLUMN cls_standard_grades.assessed_by IS
  'Soft FK to hr_employees(id) per ADR-055. The teacher who assessed the proficiency.';

CREATE TABLE IF NOT EXISTS cls_standard_grade_evidence (
    id UUID PRIMARY KEY,
    standard_grade_id UUID NOT NULL REFERENCES cls_standard_grades(id) ON DELETE CASCADE,
    evidence_type TEXT NOT NULL,
    evidence_ref_id UUID,
    description TEXT,
    added_by UUID,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_standard_grade_evidence_type_chk
      CHECK (evidence_type IN ('SUBMISSION','OBSERVATION','ASSESSMENT','TEACHER_NOTE')),
    CONSTRAINT cls_standard_grade_evidence_ref_chk
      CHECK (
        (evidence_type IN ('SUBMISSION','ASSESSMENT') AND evidence_ref_id IS NOT NULL)
        OR (evidence_type IN ('OBSERVATION','TEACHER_NOTE'))
      )
);

CREATE INDEX IF NOT EXISTS cls_standard_grade_evidence_grade_idx
  ON cls_standard_grade_evidence(standard_grade_id);

CREATE INDEX IF NOT EXISTS cls_standard_grade_evidence_type_idx
  ON cls_standard_grade_evidence(evidence_type, evidence_ref_id) WHERE evidence_ref_id IS NOT NULL;

COMMENT ON TABLE cls_standard_grade_evidence IS
  'Links a proficiency rating to the artefact that demonstrates it. 4-value evidence_type CHECK with multi-column ref_chk requiring evidence_ref_id when type is SUBMISSION or ASSESSMENT and accepting NULL for OBSERVATION + TEACHER_NOTE. evidence_ref_id is a soft polymorphic FK whose target depends on type. CASCADE on parent grade since evidence has no meaning without its rating.';

COMMENT ON COLUMN cls_standard_grade_evidence.evidence_ref_id IS
  'Soft polymorphic FK per ADR-001/020. SUBMISSION points at cls_submissions(id). ASSESSMENT points at cls_grades(id). OBSERVATION + TEACHER_NOTE carry NULL.';

CREATE TABLE IF NOT EXISTS cls_peer_review_assignments (
    id UUID PRIMARY KEY,
    assignment_id UUID NOT NULL REFERENCES cls_assignments(id) ON DELETE CASCADE,
    review_type TEXT NOT NULL DEFAULT 'RANDOM',
    reviews_per_student INT NOT NULL DEFAULT 2,
    is_anonymous BOOLEAN NOT NULL DEFAULT true,
    rubric_id UUID REFERENCES cls_rubrics(id) ON DELETE SET NULL,
    due_date TIMESTAMPTZ,
    instructions TEXT,
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_peer_review_assignments_assignment_uq
      UNIQUE (assignment_id),
    CONSTRAINT cls_peer_review_assignments_type_chk
      CHECK (review_type IN ('RANDOM','TEACHER_ASSIGNED')),
    CONSTRAINT cls_peer_review_assignments_count_chk
      CHECK (reviews_per_student > 0)
);

CREATE INDEX IF NOT EXISTS cls_peer_review_assignments_rubric_idx
  ON cls_peer_review_assignments(rubric_id) WHERE rubric_id IS NOT NULL;

COMMENT ON TABLE cls_peer_review_assignments IS
  'Per-(assignment) peer review config. UNIQUE keystone makes peer review opt-in once per assignment. review_type 2-value CHECK drives the Step 4 RandomAssigner distribution path. is_anonymous flag is consumed by the Step 4 cls_peer_reviews read path to strip reviewer identity from the DTO returned to the reviewee. rubric_id is nullable — when set peer reviewers score using the rubric via cls_rubric_scores written by the same service.';

COMMENT ON COLUMN cls_peer_review_assignments.created_by IS
  'Soft FK to hr_employees(id) per ADR-055. The teacher who enabled peer review on the assignment.';

CREATE TABLE IF NOT EXISTS cls_peer_reviews (
    id UUID PRIMARY KEY,
    peer_assignment_id UUID NOT NULL REFERENCES cls_peer_review_assignments(id) ON DELETE CASCADE,
    reviewer_student_id UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
    reviewee_submission_id UUID NOT NULL REFERENCES cls_submissions(id) ON DELETE CASCADE,
    feedback TEXT,
    overall_rating TEXT,
    status TEXT NOT NULL DEFAULT 'ASSIGNED',
    submitted_at TIMESTAMPTZ,
    teacher_reviewed_by UUID,
    teacher_reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_peer_reviews_uq
      UNIQUE (peer_assignment_id, reviewer_student_id, reviewee_submission_id),
    CONSTRAINT cls_peer_reviews_status_chk
      CHECK (status IN ('ASSIGNED','SUBMITTED','REVIEWED_BY_TEACHER')),
    CONSTRAINT cls_peer_reviews_rating_chk
      CHECK (overall_rating IS NULL OR overall_rating IN ('EXCELLENT','GOOD','DEVELOPING','NEEDS_WORK')),
    CONSTRAINT cls_peer_reviews_submitted_chk
      CHECK (
        (status = 'ASSIGNED' AND submitted_at IS NULL)
        OR (status IN ('SUBMITTED','REVIEWED_BY_TEACHER') AND submitted_at IS NOT NULL)
      )
);

CREATE INDEX IF NOT EXISTS cls_peer_reviews_reviewer_idx
  ON cls_peer_reviews(reviewer_student_id, status);

CREATE INDEX IF NOT EXISTS cls_peer_reviews_reviewee_idx
  ON cls_peer_reviews(reviewee_submission_id);

CREATE INDEX IF NOT EXISTS cls_peer_reviews_assignment_status_idx
  ON cls_peer_reviews(peer_assignment_id, status);

COMMENT ON TABLE cls_peer_reviews IS
  'Per-(peer_assignment, reviewer, reviewee_submission) review row. UNIQUE keystone caps each reviewer at one review per submission. 3-state status CHECK ASSIGNED / SUBMITTED / REVIEWED_BY_TEACHER tracks the lifecycle. Multi-column submitted_chk lockstep pins submitted_at to NULL on ASSIGNED and to NOT NULL on SUBMITTED + REVIEWED_BY_TEACHER. Anonymisation is enforced at the service layer per the load-bearing is_anonymous flag on the parent assignment — when true the reviewer identity is stripped from the DTO returned to the reviewee but stored in the row so teachers can audit.';

COMMENT ON COLUMN cls_peer_reviews.teacher_reviewed_by IS
  'Soft FK to hr_employees(id) per ADR-055. The teacher who reviewed the peer review on transition to REVIEWED_BY_TEACHER. NULL while ASSIGNED + SUBMITTED.';

CREATE TABLE IF NOT EXISTS cls_student_observations (
    id UUID PRIMARY KEY,
    class_id UUID NOT NULL REFERENCES sis_classes(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
    teacher_id UUID NOT NULL,
    note_text TEXT NOT NULL,
    note_type TEXT NOT NULL,
    is_shared_with_parent BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_student_observations_type_chk
      CHECK (note_type IN ('PROGRESS','CONCERN','COMMENDATION')),
    CONSTRAINT cls_student_observations_text_chk
      CHECK (length(trim(note_text)) > 0)
);

CREATE INDEX IF NOT EXISTS cls_student_observations_class_student_idx
  ON cls_student_observations(class_id, student_id, created_at DESC);

CREATE INDEX IF NOT EXISTS cls_student_observations_student_idx
  ON cls_student_observations(student_id, created_at DESC);

CREATE INDEX IF NOT EXISTS cls_student_observations_parent_visible_idx
  ON cls_student_observations(student_id, created_at DESC) WHERE is_shared_with_parent = true;

COMMENT ON TABLE cls_student_observations IS
  'Lighter than report cards — mid-term observations. The plan name cls_student_progress_notes is already taken by Cycle 2 with a different shape (UNIQUE per term, summary-style note). This new table is the observation log — multiple per term with a note_type categorisation and a separate is_shared_with_parent visibility flag. Both tables coexist and serve different surfaces.';

COMMENT ON COLUMN cls_student_observations.teacher_id IS
  'Soft FK to hr_employees(id) per ADR-055. The teacher who authored the observation.';

CREATE TABLE IF NOT EXISTS cls_report_card_subjects (
    id UUID PRIMARY KEY,
    report_card_id UUID NOT NULL REFERENCES cls_report_cards(id) ON DELETE CASCADE,
    subject_label TEXT NOT NULL,
    course_id UUID,
    final_grade TEXT,
    grade_value NUMERIC(5,2),
    teacher_comments TEXT,
    effort_grade TEXT,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_report_card_subjects_label_chk
      CHECK (length(trim(subject_label)) > 0),
    CONSTRAINT cls_report_card_subjects_grade_value_chk
      CHECK (grade_value IS NULL OR grade_value >= 0)
);

CREATE INDEX IF NOT EXISTS cls_report_card_subjects_report_card_idx
  ON cls_report_card_subjects(report_card_id, sort_order);

COMMENT ON TABLE cls_report_card_subjects IS
  'Snapshot per-(report_card, subject) row. course_id is a nullable soft FK to sis_courses so subject_label can be a free-text snapshot that survives course catalogue changes. Adds teacher_comments + effort_grade columns over the existing cls_report_card_entries from Cycle 2.';

COMMENT ON COLUMN cls_report_card_subjects.course_id IS
  'Soft FK to sis_courses(id) per ADR-001/020. Nullable — the subject_label snapshot is the source of truth.';

CREATE TABLE IF NOT EXISTS cls_formative_assessments (
    id UUID PRIMARY KEY,
    class_id UUID NOT NULL REFERENCES sis_classes(id) ON DELETE CASCADE,
    created_by UUID NOT NULL,
    title TEXT NOT NULL,
    assessment_type TEXT NOT NULL,
    questions JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT false,
    activated_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_formative_assessments_type_chk
      CHECK (assessment_type IN ('EXIT_TICKET','POLL','QUICK_CHECK','DO_NOW')),
    CONSTRAINT cls_formative_assessments_title_chk
      CHECK (length(trim(title)) > 0),
    CONSTRAINT cls_formative_assessments_active_chk
      CHECK (
        (is_active = true AND activated_at IS NOT NULL AND closed_at IS NULL)
        OR (is_active = false)
      )
);

CREATE INDEX IF NOT EXISTS cls_formative_assessments_class_active_idx
  ON cls_formative_assessments(class_id, is_active);

CREATE INDEX IF NOT EXISTS cls_formative_assessments_class_created_idx
  ON cls_formative_assessments(class_id, created_at DESC);

COMMENT ON TABLE cls_formative_assessments IS
  'Per-(class) quick check for understanding. assessment_type 4-value CHECK EXIT_TICKET / POLL / QUICK_CHECK / DO_NOW. questions JSONB is the array of {prompt, response_type, options} shapes. The Step 4 PATCH /:id/activate locks the row and flips is_active plus stamps activated_at in one tx — the multi-column active_chk keeps these in lockstep.';

COMMENT ON COLUMN cls_formative_assessments.created_by IS
  'Soft FK to hr_employees(id) per ADR-055. The teacher who created the assessment.';

CREATE TABLE IF NOT EXISTS cls_formative_responses (
    id UUID PRIMARY KEY,
    assessment_id UUID NOT NULL REFERENCES cls_formative_assessments(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
    responses JSONB NOT NULL DEFAULT '{}'::jsonb,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_formative_responses_uq
      UNIQUE (assessment_id, student_id)
);

CREATE INDEX IF NOT EXISTS cls_formative_responses_assessment_idx
  ON cls_formative_responses(assessment_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS cls_formative_responses_student_idx
  ON cls_formative_responses(student_id);

COMMENT ON TABLE cls_formative_responses IS
  'Per-(assessment, student) student response. UNIQUE keystone caps each student at one response per assessment. responses JSONB is a keyed map of question_id to response_value matching the questions array shape on the parent. Real-time classroom check-for-understanding feeds back to the teacher via GET /:id/results aggregate.';
