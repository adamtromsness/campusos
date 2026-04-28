CREATE TABLE IF NOT EXISTS cls_submissions (
    id UUID PRIMARY KEY,
    assignment_id UUID NOT NULL REFERENCES cls_assignments(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES sis_students(id),
    status TEXT NOT NULL DEFAULT 'NOT_STARTED',
    submission_text TEXT,
    attachments JSONB NOT NULL DEFAULT '[]',
    submitted_at TIMESTAMPTZ,
    returned_at TIMESTAMPTZ,
    return_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_submissions_status_chk CHECK (status IN ('NOT_STARTED','IN_PROGRESS','SUBMITTED','GRADED','RETURNED')),
    CONSTRAINT cls_submissions_assignment_student_uq UNIQUE (assignment_id, student_id)
);
CREATE INDEX IF NOT EXISTS cls_submissions_student_idx ON cls_submissions(student_id);
CREATE INDEX IF NOT EXISTS cls_submissions_assignment_idx ON cls_submissions(assignment_id);
CREATE INDEX IF NOT EXISTS cls_submissions_assignment_submitted_idx ON cls_submissions(assignment_id, submitted_at DESC) WHERE status = 'SUBMITTED';
CREATE TABLE IF NOT EXISTS cls_submission_question_grades (
    id UUID PRIMARY KEY,
    submission_id UUID NOT NULL REFERENCES cls_submissions(id) ON DELETE CASCADE,
    question_id UUID NOT NULL REFERENCES cls_assignment_questions(id) ON DELETE CASCADE,
    student_response TEXT,
    ai_suggested_points NUMERIC(5,2),
    ai_confidence NUMERIC(3,2),
    teacher_awarded_points NUMERIC(5,2),
    feedback TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_submission_question_grades_uq UNIQUE (submission_id, question_id),
    CONSTRAINT cls_submission_question_grades_ai_conf_chk CHECK (ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1))
);
CREATE INDEX IF NOT EXISTS cls_submission_question_grades_submission_idx ON cls_submission_question_grades(submission_id);
CREATE INDEX IF NOT EXISTS cls_submission_question_grades_question_idx ON cls_submission_question_grades(question_id);
CREATE TABLE IF NOT EXISTS cls_ai_grading_jobs (
    id UUID PRIMARY KEY,
    submission_id UUID NOT NULL REFERENCES cls_submissions(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'PENDING',
    ai_suggested_grade NUMERIC(6,2),
    ai_confidence NUMERIC(3,2),
    ai_reasoning TEXT,
    model_version TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_ai_grading_jobs_status_chk CHECK (status IN ('PENDING','RUNNING','COMPLETE','FAILED')),
    CONSTRAINT cls_ai_grading_jobs_ai_conf_chk CHECK (ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1))
);
CREATE INDEX IF NOT EXISTS cls_ai_grading_jobs_submission_idx ON cls_ai_grading_jobs(submission_id);
CREATE INDEX IF NOT EXISTS cls_ai_grading_jobs_pending_idx ON cls_ai_grading_jobs(status) WHERE status IN ('PENDING','RUNNING');
CREATE TABLE IF NOT EXISTS cls_grades (
    id UUID PRIMARY KEY,
    assignment_id UUID NOT NULL REFERENCES cls_assignments(id),
    student_id UUID NOT NULL REFERENCES sis_students(id),
    submission_id UUID REFERENCES cls_submissions(id),
    teacher_id UUID NOT NULL,
    grade_value NUMERIC(6,2) NOT NULL,
    letter_grade TEXT,
    feedback TEXT,
    is_published BOOLEAN NOT NULL DEFAULT false,
    graded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_grades_assignment_student_uq UNIQUE (assignment_id, student_id),
    CONSTRAINT cls_grades_value_chk CHECK (grade_value >= 0)
);
CREATE INDEX IF NOT EXISTS cls_grades_assignment_idx ON cls_grades(assignment_id);
CREATE INDEX IF NOT EXISTS cls_grades_student_idx ON cls_grades(student_id);
CREATE INDEX IF NOT EXISTS cls_grades_teacher_idx ON cls_grades(teacher_id);
COMMENT ON COLUMN cls_grades.teacher_id IS 'Soft FK to hr_employees(id) per ADR-055 (resolved in Cycle 4 Step 0). Written from actor.employeeId via ActorContextService.resolveActor(...). Until Cycle 4 Step 0 the column held iam_person.id directly (REVIEW-CYCLE2 DEVIATION 4) and the seed-hr bridge UPDATE re-pointed every existing row to hr_employees.id.';
CREATE INDEX IF NOT EXISTS cls_grades_assignment_published_idx ON cls_grades(assignment_id) WHERE is_published = true;
CREATE INDEX IF NOT EXISTS cls_grades_student_published_idx ON cls_grades(student_id) WHERE is_published = true;
CREATE TABLE IF NOT EXISTS cls_gradebook_snapshots (
    id UUID PRIMARY KEY,
    class_id UUID NOT NULL REFERENCES sis_classes(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES sis_students(id),
    term_id UUID NOT NULL REFERENCES sis_terms(id),
    current_average NUMERIC(5,2),
    letter_grade TEXT,
    assignments_graded INT NOT NULL DEFAULT 0,
    assignments_total INT NOT NULL DEFAULT 0,
    last_grade_event_at TIMESTAMPTZ,
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_gradebook_snapshots_class_student_term_uq UNIQUE (class_id, student_id, term_id),
    CONSTRAINT cls_gradebook_snapshots_avg_chk CHECK (current_average IS NULL OR current_average >= 0)
);
CREATE INDEX IF NOT EXISTS cls_gradebook_snapshots_student_term_idx ON cls_gradebook_snapshots(student_id, term_id);
CREATE INDEX IF NOT EXISTS cls_gradebook_snapshots_class_term_idx ON cls_gradebook_snapshots(class_id, term_id);
CREATE TABLE IF NOT EXISTS cls_report_cards (
    id UUID PRIMARY KEY,
    student_id UUID NOT NULL REFERENCES sis_students(id),
    class_id UUID NOT NULL REFERENCES sis_classes(id),
    term_id UUID NOT NULL REFERENCES sis_terms(id),
    status TEXT NOT NULL DEFAULT 'DRAFT',
    published_at TIMESTAMPTZ,
    finalized_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_report_cards_status_chk CHECK (status IN ('DRAFT','PUBLISHED')),
    CONSTRAINT cls_report_cards_student_class_term_uq UNIQUE (student_id, class_id, term_id)
);
CREATE INDEX IF NOT EXISTS cls_report_cards_student_term_idx ON cls_report_cards(student_id, term_id);
CREATE INDEX IF NOT EXISTS cls_report_cards_class_term_idx ON cls_report_cards(class_id, term_id);
CREATE INDEX IF NOT EXISTS cls_report_cards_published_idx ON cls_report_cards(class_id, term_id) WHERE status = 'PUBLISHED';
CREATE TABLE IF NOT EXISTS cls_report_card_entries (
    id UUID PRIMARY KEY,
    report_card_id UUID NOT NULL REFERENCES cls_report_cards(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    final_grade TEXT,
    grade_value NUMERIC(5,2),
    teacher_comments TEXT,
    effort_grade TEXT,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_report_card_entries_card_subject_uq UNIQUE (report_card_id, subject)
);
CREATE INDEX IF NOT EXISTS cls_report_card_entries_card_idx ON cls_report_card_entries(report_card_id);
CREATE TABLE IF NOT EXISTS cls_student_progress_notes (
    id UUID PRIMARY KEY,
    class_id UUID NOT NULL REFERENCES sis_classes(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES sis_students(id),
    term_id UUID NOT NULL REFERENCES sis_terms(id),
    author_id UUID NOT NULL,
    note_text TEXT NOT NULL,
    overall_effort_rating TEXT,
    is_parent_visible BOOLEAN NOT NULL DEFAULT false,
    is_student_visible BOOLEAN NOT NULL DEFAULT false,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_student_progress_notes_class_student_term_uq UNIQUE (class_id, student_id, term_id),
    CONSTRAINT cls_student_progress_notes_effort_chk CHECK (overall_effort_rating IS NULL OR overall_effort_rating IN ('EXCELLENT','GOOD','SATISFACTORY','NEEDS_IMPROVEMENT','UNSATISFACTORY'))
);
CREATE INDEX IF NOT EXISTS cls_student_progress_notes_student_idx ON cls_student_progress_notes(student_id);
CREATE INDEX IF NOT EXISTS cls_student_progress_notes_class_term_idx ON cls_student_progress_notes(class_id, term_id);
CREATE INDEX IF NOT EXISTS cls_student_progress_notes_parent_visible_idx ON cls_student_progress_notes(student_id) WHERE is_parent_visible = true AND published_at IS NOT NULL;
COMMENT ON COLUMN cls_student_progress_notes.author_id IS 'Soft FK to hr_employees(id) per ADR-055 (resolved in Cycle 4 Step 0). Written from actor.employeeId via ActorContextService.resolveActor(...). Until Cycle 4 Step 0 the column held iam_person.id directly (REVIEW-CYCLE2 DEVIATION 4) and the seed-hr bridge UPDATE re-pointed every existing row to hr_employees.id.'
