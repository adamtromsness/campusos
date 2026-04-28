/* 011_hr_employees_and_positions.sql
 * Cycle 4 Steps 0 and 1 — HR Employees and Positions schema.
 *
 * Step 0 lands hr_employees as the canonical bridge between iam_person and the four
 * staff-side soft-FK columns (sis_class_teachers.teacher_employee_id,
 * cls_grades.teacher_id, cls_lessons.teacher_id, cls_student_progress_notes.author_id)
 * that have temporarily held iam_person.id since Cycle 2 Step 5
 * (REVIEW-CYCLE2 DEVIATION 4).
 *
 * Step 1 adds the rest of the Employees and Positions tables: hr_positions,
 * hr_employee_positions (time-bounded position history), hr_emergency_contacts,
 * hr_document_types, hr_employee_documents.
 *
 * Soft FKs to platform.* per ADR-001/020 (no DB-enforced cross-schema FKs).
 * UNIQUE(person_id) + UNIQUE(account_id) so each iam_person and each
 * platform_users account binds to at most one hr_employees row.
 *
 * Intra-tenant FKs are DB-enforced where the parent is unpartitioned:
 *   hr_employee_positions.employee_id → hr_employees(id)
 *   hr_employee_positions.position_id → hr_positions(id)
 *   hr_emergency_contacts.employee_id → hr_employees(id)
 *   hr_employee_documents.employee_id → hr_employees(id)
 *   hr_employee_documents.document_type_id → hr_document_types(id)
 * hr_positions.department_id is a soft FK to sis_departments(id) — the
 * sis_departments table predates HR, the relationship is informational, and
 * a hard FK would create awkward delete coupling between SIS and HR.
 *
 * Block-comment style required per the splitter quirk — line-comment headers
 * cause the first statement to be filtered. No semicolons inside any string
 * literal (CHECK predicates, defaults, COMMENTs) — the splitter cuts on every
 * semicolon regardless of quoting context, including inside block comments.
 * Idempotent — safe to re-run.
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
CREATE TABLE IF NOT EXISTS hr_positions (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    title TEXT NOT NULL,
    department_id UUID,
    is_teaching_role BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_positions_school_title_uq UNIQUE (school_id, title)
);
CREATE INDEX IF NOT EXISTS hr_positions_school_active_idx ON hr_positions(school_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS hr_positions_department_idx ON hr_positions(department_id) WHERE department_id IS NOT NULL;
COMMENT ON COLUMN hr_positions.department_id IS 'Soft FK to sis_departments(id). Informational — left unenforced so the SIS module can evolve independently of HR.';
CREATE TABLE IF NOT EXISTS hr_employee_positions (
    id UUID PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    position_id UUID NOT NULL REFERENCES hr_positions(id),
    is_primary BOOLEAN NOT NULL DEFAULT true,
    fte NUMERIC(4,3) NOT NULL DEFAULT 1.000,
    effective_from DATE NOT NULL,
    effective_to DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_employee_positions_dates_chk CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT hr_employee_positions_fte_chk CHECK (fte > 0 AND fte <= 1.000)
);
CREATE INDEX IF NOT EXISTS hr_employee_positions_employee_idx ON hr_employee_positions(employee_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS hr_employee_positions_position_idx ON hr_employee_positions(position_id);
CREATE UNIQUE INDEX IF NOT EXISTS hr_employee_positions_one_primary_uq ON hr_employee_positions(employee_id) WHERE is_primary = true AND effective_to IS NULL;
CREATE TABLE IF NOT EXISTS hr_emergency_contacts (
    id UUID PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    relationship TEXT,
    phone TEXT NOT NULL,
    email TEXT,
    is_primary BOOLEAN NOT NULL DEFAULT false,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hr_emergency_contacts_employee_idx ON hr_emergency_contacts(employee_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS hr_emergency_contacts_one_primary_uq ON hr_emergency_contacts(employee_id) WHERE is_primary = true;
CREATE TABLE IF NOT EXISTS hr_document_types (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    is_required BOOLEAN NOT NULL DEFAULT false,
    retention_days INT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_document_types_school_name_uq UNIQUE (school_id, name),
    CONSTRAINT hr_document_types_retention_chk CHECK (retention_days IS NULL OR retention_days > 0)
);
CREATE INDEX IF NOT EXISTS hr_document_types_school_active_idx ON hr_document_types(school_id) WHERE is_active = true;
CREATE TABLE IF NOT EXISTS hr_employee_documents (
    id UUID PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    document_type_id UUID NOT NULL REFERENCES hr_document_types(id),
    file_name TEXT NOT NULL,
    s3_key TEXT NOT NULL,
    content_type TEXT,
    file_size_bytes BIGINT,
    uploaded_by UUID NOT NULL,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expiry_date DATE,
    is_archived BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_employee_documents_size_chk CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0)
);
CREATE INDEX IF NOT EXISTS hr_employee_documents_employee_type_idx ON hr_employee_documents(employee_id, document_type_id);
CREATE INDEX IF NOT EXISTS hr_employee_documents_expiry_idx ON hr_employee_documents(expiry_date) WHERE expiry_date IS NOT NULL AND is_archived = false;
COMMENT ON COLUMN hr_employee_documents.uploaded_by IS 'Soft FK to platform.platform_users(id) per ADR-055 — the account that uploaded the file, used for audit. Not a DB-enforced FK because users may be deactivated independently of their upload history.';
COMMENT ON COLUMN hr_employee_documents.s3_key IS 'Object key in the school document bucket. The file itself is fetched via a signed URL minted by EmployeeDocumentService — never streamed through the API.';
