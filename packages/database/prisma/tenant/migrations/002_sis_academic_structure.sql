CREATE TABLE IF NOT EXISTS sis_academic_years (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    name TEXT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_current BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sis_academic_years_dates_chk CHECK (end_date > start_date),
    CONSTRAINT sis_academic_years_school_start_uq UNIQUE (school_id, start_date)
);
CREATE INDEX IF NOT EXISTS sis_academic_years_school_idx ON sis_academic_years(school_id);
CREATE UNIQUE INDEX IF NOT EXISTS sis_academic_years_one_current_uq ON sis_academic_years(school_id) WHERE is_current = true;
CREATE TABLE IF NOT EXISTS sis_terms (
    id UUID PRIMARY KEY,
    academic_year_id UUID NOT NULL REFERENCES sis_academic_years(id),
    name TEXT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    term_type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sis_terms_term_type_chk CHECK (term_type IN ('SEMESTER','QUARTER','TRIMESTER','FULL_YEAR')),
    CONSTRAINT sis_terms_dates_chk CHECK (end_date > start_date)
);
CREATE INDEX IF NOT EXISTS sis_terms_year_idx ON sis_terms(academic_year_id);
CREATE TABLE IF NOT EXISTS sis_departments (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    name TEXT NOT NULL,
    head_employee_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sis_departments_school_name_uq UNIQUE (school_id, name)
);
CREATE TABLE IF NOT EXISTS sis_courses (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    department_id UUID REFERENCES sis_departments(id),
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    credit_hours NUMERIC(3,1),
    grade_level TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sis_courses_school_code_uq UNIQUE (school_id, code)
);
CREATE INDEX IF NOT EXISTS sis_courses_department_idx ON sis_courses(department_id);
CREATE TABLE IF NOT EXISTS sis_classes (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    course_id UUID NOT NULL REFERENCES sis_courses(id),
    academic_year_id UUID NOT NULL REFERENCES sis_academic_years(id),
    term_id UUID REFERENCES sis_terms(id),
    section_code TEXT NOT NULL,
    room TEXT,
    max_enrollment INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sis_classes_course_term_section_uq UNIQUE (course_id, academic_year_id, term_id, section_code)
);
CREATE INDEX IF NOT EXISTS sis_classes_school_year_idx ON sis_classes(school_id, academic_year_id);
CREATE INDEX IF NOT EXISTS sis_classes_course_idx ON sis_classes(course_id);
CREATE INDEX IF NOT EXISTS sis_classes_term_idx ON sis_classes(term_id);
CREATE TABLE IF NOT EXISTS sis_class_teachers (
    id UUID PRIMARY KEY,
    class_id UUID NOT NULL REFERENCES sis_classes(id) ON DELETE CASCADE,
    teacher_employee_id UUID NOT NULL,
    is_primary_teacher BOOLEAN NOT NULL DEFAULT false,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sis_class_teachers_class_teacher_uq UNIQUE (class_id, teacher_employee_id)
);
CREATE INDEX IF NOT EXISTS sis_class_teachers_teacher_idx ON sis_class_teachers(teacher_employee_id);
COMMENT ON COLUMN sis_class_teachers.teacher_employee_id IS 'Soft FK to hr_employees(id) per ADR-055 (resolved in Cycle 4 Step 0). Resolve the calling employee via actor.employeeId from ActorContextService.resolveActor(...). Until Cycle 4 Step 0 the column held iam_person.id directly (REVIEW-CYCLE2 DEVIATION 4) and the seed-hr bridge UPDATE re-pointed every existing row to hr_employees.id.';
CREATE TABLE IF NOT EXISTS sis_enrollments (
    id UUID PRIMARY KEY,
    student_id UUID NOT NULL,
    class_id UUID NOT NULL REFERENCES sis_classes(id),
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    dropped_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sis_enrollments_status_chk CHECK (status IN ('ACTIVE','DROPPED','TRANSFERRED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS sis_enrollments_active_uq ON sis_enrollments(student_id, class_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS sis_enrollments_class_idx ON sis_enrollments(class_id);
CREATE INDEX IF NOT EXISTS sis_enrollments_student_idx ON sis_enrollments(student_id);
