CREATE TABLE IF NOT EXISTS cls_lesson_types (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    name TEXT NOT NULL,
    icon TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_lesson_types_school_name_uq UNIQUE (school_id, name)
);
CREATE INDEX IF NOT EXISTS cls_lesson_types_school_idx ON cls_lesson_types(school_id);
CREATE TABLE IF NOT EXISTS cls_lessons (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    class_id UUID REFERENCES sis_classes(id) ON DELETE CASCADE,
    teacher_id UUID,
    lesson_type_id UUID REFERENCES cls_lesson_types(id),
    bank_lesson_id UUID,
    title TEXT NOT NULL,
    description TEXT,
    date DATE,
    duration_minutes INT,
    learning_objectives TEXT[] NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'DRAFT',
    is_template BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_lessons_status_chk CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED','TEMPLATE')),
    CONSTRAINT cls_lessons_template_class_chk CHECK (
        (is_template = true AND class_id IS NULL) OR (is_template = false)
    )
);
CREATE INDEX IF NOT EXISTS cls_lessons_class_idx ON cls_lessons(class_id);
CREATE INDEX IF NOT EXISTS cls_lessons_teacher_idx ON cls_lessons(teacher_id);
COMMENT ON COLUMN cls_lessons.teacher_id IS 'Soft FK to hr_employees(id) per ADR-055 (resolved in Cycle 4 Step 0). Resolve via actor.employeeId from ActorContextService.resolveActor(...). Until Cycle 4 Step 0 the column held iam_person.id directly (REVIEW-CYCLE2 DEVIATION 4) and the seed-hr bridge UPDATE re-pointed every existing row to hr_employees.id.';
CREATE INDEX IF NOT EXISTS cls_lessons_class_date_idx ON cls_lessons(class_id, date) WHERE class_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cls_lessons_template_idx ON cls_lessons(school_id) WHERE is_template = true;
CREATE TABLE IF NOT EXISTS cls_assignment_types (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    name TEXT NOT NULL,
    weight_in_category NUMERIC(5,2) NOT NULL DEFAULT 100.00,
    category TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_assignment_types_school_name_uq UNIQUE (school_id, name),
    CONSTRAINT cls_assignment_types_category_chk CHECK (category IN ('HOMEWORK','QUIZ','TEST','PROJECT','CLASSWORK')),
    CONSTRAINT cls_assignment_types_weight_chk CHECK (weight_in_category >= 0 AND weight_in_category <= 100)
);
CREATE INDEX IF NOT EXISTS cls_assignment_types_school_idx ON cls_assignment_types(school_id);
CREATE TABLE IF NOT EXISTS cls_assignment_categories (
    id UUID PRIMARY KEY,
    class_id UUID NOT NULL REFERENCES sis_classes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    weight NUMERIC(5,2) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_assignment_categories_class_name_uq UNIQUE (class_id, name),
    CONSTRAINT cls_assignment_categories_weight_chk CHECK (weight >= 0 AND weight <= 100)
);
CREATE INDEX IF NOT EXISTS cls_assignment_categories_class_idx ON cls_assignment_categories(class_id);
CREATE TABLE IF NOT EXISTS cls_assignments (
    id UUID PRIMARY KEY,
    class_id UUID NOT NULL REFERENCES sis_classes(id) ON DELETE CASCADE,
    lesson_id UUID REFERENCES cls_lessons(id),
    assignment_type_id UUID NOT NULL REFERENCES cls_assignment_types(id),
    category_id UUID REFERENCES cls_assignment_categories(id),
    grading_scale_id UUID REFERENCES grading_scales(id),
    title TEXT NOT NULL,
    instructions TEXT,
    due_date TIMESTAMPTZ,
    max_points NUMERIC(6,2) NOT NULL DEFAULT 100.00,
    is_ai_grading_enabled BOOLEAN NOT NULL DEFAULT false,
    is_extra_credit BOOLEAN NOT NULL DEFAULT false,
    is_published BOOLEAN NOT NULL DEFAULT false,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_assignments_max_points_chk CHECK (max_points > 0)
);
CREATE INDEX IF NOT EXISTS cls_assignments_class_due_idx ON cls_assignments(class_id, due_date);
CREATE INDEX IF NOT EXISTS cls_assignments_lesson_idx ON cls_assignments(lesson_id);
CREATE INDEX IF NOT EXISTS cls_assignments_type_idx ON cls_assignments(assignment_type_id);
CREATE INDEX IF NOT EXISTS cls_assignments_category_idx ON cls_assignments(category_id);
CREATE INDEX IF NOT EXISTS cls_assignments_class_active_idx ON cls_assignments(class_id) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS cls_assignment_questions (
    id UUID PRIMARY KEY,
    assignment_id UUID NOT NULL REFERENCES cls_assignments(id) ON DELETE CASCADE,
    question_text TEXT NOT NULL,
    question_type TEXT NOT NULL,
    points NUMERIC(5,2) NOT NULL DEFAULT 1.00,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_assignment_questions_type_chk CHECK (question_type IN ('MULTIPLE_CHOICE','SHORT_ANSWER','ESSAY','TRUE_FALSE','FILE_UPLOAD')),
    CONSTRAINT cls_assignment_questions_points_chk CHECK (points >= 0)
);
CREATE INDEX IF NOT EXISTS cls_assignment_questions_assignment_idx ON cls_assignment_questions(assignment_id, sort_order);
CREATE TABLE IF NOT EXISTS cls_answer_key_entries (
    id UUID PRIMARY KEY,
    question_id UUID NOT NULL REFERENCES cls_assignment_questions(id) ON DELETE CASCADE,
    option_index INT NOT NULL DEFAULT 0,
    correct_answer TEXT,
    explanation TEXT,
    is_correct BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_answer_key_entries_question_option_uq UNIQUE (question_id, option_index)
);
CREATE INDEX IF NOT EXISTS cls_answer_key_entries_question_idx ON cls_answer_key_entries(question_id)
