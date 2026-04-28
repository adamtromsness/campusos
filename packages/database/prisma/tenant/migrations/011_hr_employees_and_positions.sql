/* 011_hr_employees_and_positions.sql
 * Cycle 4 Step 0 — HR-Employee Identity Migration (carry-over from Cycle 2).
 *
 * Lands hr_employees as the canonical bridge between iam_person and the four
 * staff-side soft-FK columns (sis_class_teachers.teacher_employee_id,
 * cls_grades.teacher_id, cls_lessons.teacher_id, cls_student_progress_notes.author_id)
 * that have temporarily held iam_person.id since Cycle 2 Step 5
 * (REVIEW-CYCLE2 DEVIATION 4).
 *
 * Step 1 of Cycle 4 will append the rest of the Employees and Positions tables
 * to this file (hr_positions, hr_employee_positions, hr_emergency_contacts,
 * hr_document_types, hr_employee_documents).
 *
 * Soft FKs to platform.* per ADR-001/020 (no DB-enforced cross-schema FKs).
 * UNIQUE(person_id) + UNIQUE(account_id) so each iam_person and each
 * platform_users account binds to at most one hr_employees row.
 *
 * Block-comment style required per the splitter quirk — line-comment headers
 * cause the first statement to be filtered. Idempotent — safe to re-run.
 */
CREATE TABLE IF NOT EXISTS hr_employees (
    id UUID PRIMARY KEY,
    person_id UUID NOT NULL,
    account_id UUID NOT NULL,
    school_id UUID NOT NULL,
    employee_number TEXT,
    employment_type TEXT NOT NULL,
    employment_status TEXT NOT NULL DEFAULT 'ACTIVE',
    hire_date DATE NOT NULL,
    termination_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_employees_employment_type_chk CHECK (employment_type IN ('FULL_TIME','PART_TIME','CONTRACT','TEMPORARY','INTERN','VOLUNTEER')),
    CONSTRAINT hr_employees_employment_status_chk CHECK (employment_status IN ('ACTIVE','ON_LEAVE','TERMINATED','SUSPENDED')),
    CONSTRAINT hr_employees_person_uq UNIQUE (person_id),
    CONSTRAINT hr_employees_account_uq UNIQUE (account_id)
);
CREATE INDEX IF NOT EXISTS hr_employees_school_status_idx ON hr_employees(school_id, employment_status);
CREATE INDEX IF NOT EXISTS hr_employees_employee_number_idx ON hr_employees(employee_number) WHERE employee_number IS NOT NULL;
COMMENT ON COLUMN hr_employees.person_id IS 'Soft FK to platform.iam_person(id) per ADR-055. UNIQUE so at most one hr_employees row per iam_person. Bridge column used by Cycle 4 Step 0 to re-point sis_class_teachers, cls_grades, cls_lessons, cls_student_progress_notes from holding iam_person.id directly to holding hr_employees.id.';
COMMENT ON COLUMN hr_employees.account_id IS 'Soft FK to platform.platform_users(id) per ADR-055. UNIQUE. Lets EmployeeService resolve the calling employee from the JWT subject without an iam_person round-trip.';
COMMENT ON COLUMN hr_employees.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020. Denormalised for observability queries — every read is already tenant-scoped via search_path.';
