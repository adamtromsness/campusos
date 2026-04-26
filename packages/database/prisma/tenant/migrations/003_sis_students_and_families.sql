CREATE TABLE IF NOT EXISTS sis_families (
    id UUID PRIMARY KEY,
    organisation_id UUID,
    family_name TEXT NOT NULL,
    primary_address TEXT,
    city TEXT,
    postcode TEXT,
    country_code CHAR(2),
    notes TEXT,
    platform_family_id UUID,
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sis_families_organisation_idx ON sis_families(organisation_id) WHERE organisation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sis_families_platform_family_idx ON sis_families(platform_family_id) WHERE platform_family_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS sis_students (
    id UUID PRIMARY KEY,
    platform_student_id UUID NOT NULL UNIQUE,
    school_id UUID NOT NULL,
    student_number TEXT,
    grade_level TEXT,
    homeroom_class_id UUID REFERENCES sis_classes(id),
    enrollment_status TEXT NOT NULL DEFAULT 'ENROLLED',
    withdrawal_id UUID,
    re_enrollment_hold BOOLEAN NOT NULL DEFAULT false,
    re_enrollment_hold_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sis_students_enrollment_status_chk CHECK (enrollment_status IN ('ENROLLED','TRANSFERRED','GRADUATED','WITHDRAWN')),
    CONSTRAINT sis_students_school_number_uq UNIQUE (school_id, student_number)
);
CREATE INDEX IF NOT EXISTS sis_students_school_idx ON sis_students(school_id);
CREATE INDEX IF NOT EXISTS sis_students_homeroom_idx ON sis_students(homeroom_class_id);
CREATE INDEX IF NOT EXISTS sis_students_grade_level_idx ON sis_students(school_id, grade_level);
CREATE TABLE IF NOT EXISTS sis_staff (
    id UUID PRIMARY KEY,
    person_id UUID NOT NULL UNIQUE,
    account_id UUID NOT NULL UNIQUE,
    school_id UUID,
    employee_id UUID,
    staff_type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sis_staff_staff_type_chk CHECK (staff_type IN ('TEACHER','ADMINISTRATOR','SUPPORT','COUNSELLOR'))
);
CREATE INDEX IF NOT EXISTS sis_staff_school_idx ON sis_staff(school_id);
CREATE INDEX IF NOT EXISTS sis_staff_employee_idx ON sis_staff(employee_id) WHERE employee_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS sis_guardians (
    id UUID PRIMARY KEY,
    person_id UUID NOT NULL,
    account_id UUID UNIQUE,
    school_id UUID NOT NULL,
    family_id UUID REFERENCES sis_families(id),
    relationship TEXT NOT NULL,
    preferred_contact_method TEXT NOT NULL DEFAULT 'EMAIL',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sis_guardians_relationship_chk CHECK (relationship IN ('PARENT','GUARDIAN','GRANDPARENT','FOSTER_PARENT','OTHER')),
    CONSTRAINT sis_guardians_preferred_contact_chk CHECK (preferred_contact_method IN ('EMAIL','SMS','APP','PHONE')),
    CONSTRAINT sis_guardians_school_person_uq UNIQUE (school_id, person_id)
);
CREATE INDEX IF NOT EXISTS sis_guardians_school_idx ON sis_guardians(school_id);
CREATE INDEX IF NOT EXISTS sis_guardians_family_idx ON sis_guardians(family_id) WHERE family_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS sis_student_guardians (
    id UUID PRIMARY KEY,
    student_id UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
    guardian_id UUID NOT NULL REFERENCES sis_guardians(id) ON DELETE CASCADE,
    has_custody BOOLEAN NOT NULL DEFAULT false,
    is_emergency_contact BOOLEAN NOT NULL DEFAULT false,
    receives_reports BOOLEAN NOT NULL DEFAULT true,
    portal_access BOOLEAN NOT NULL DEFAULT false,
    portal_access_scope TEXT NOT NULL DEFAULT 'FULL',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sis_student_guardians_portal_scope_chk CHECK (portal_access_scope IN ('FULL','ACADEMIC_ONLY','COMMUNICATIONS_ONLY')),
    CONSTRAINT sis_student_guardians_student_guardian_uq UNIQUE (student_id, guardian_id)
);
CREATE INDEX IF NOT EXISTS sis_student_guardians_guardian_idx ON sis_student_guardians(guardian_id);
CREATE TABLE IF NOT EXISTS sis_family_members (
    id UUID PRIMARY KEY,
    family_id UUID NOT NULL REFERENCES sis_families(id) ON DELETE CASCADE,
    person_id UUID NOT NULL,
    person_type TEXT NOT NULL,
    relationship_to_family TEXT,
    is_primary_contact BOOLEAN NOT NULL DEFAULT false,
    joined_family_at DATE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sis_family_members_person_type_chk CHECK (person_type IN ('STUDENT','GUARDIAN','PARENT','STEP_PARENT','GRANDPARENT','FOSTER_PARENT','OTHER_ADULT')),
    CONSTRAINT sis_family_members_relationship_chk CHECK (relationship_to_family IS NULL OR relationship_to_family IN ('CHILD','STEP_CHILD','FOSTER_CHILD','GRANDCHILD','OTHER')),
    CONSTRAINT sis_family_members_family_person_uq UNIQUE (family_id, person_id)
);
CREATE INDEX IF NOT EXISTS sis_family_members_family_type_idx ON sis_family_members(family_id, person_type);
CREATE INDEX IF NOT EXISTS sis_family_members_person_idx ON sis_family_members(person_id);
CREATE UNIQUE INDEX IF NOT EXISTS sis_family_members_one_primary_uq ON sis_family_members(family_id) WHERE is_primary_contact = true;
CREATE TABLE IF NOT EXISTS sis_emergency_contacts (
    id UUID PRIMARY KEY,
    student_id UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    relationship TEXT,
    phone TEXT,
    is_authorised_pickup BOOLEAN NOT NULL DEFAULT false,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sis_emergency_contacts_student_idx ON sis_emergency_contacts(student_id);
CREATE TABLE IF NOT EXISTS sis_student_notes (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    student_id UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
    author_id UUID NOT NULL,
    note_type TEXT NOT NULL,
    note_text TEXT NOT NULL,
    is_parent_visible BOOLEAN NOT NULL DEFAULT false,
    is_shared_with_counselor BOOLEAN NOT NULL DEFAULT false,
    is_confidential BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sis_student_notes_note_type_chk CHECK (note_type IN ('PASTORAL','ACADEMIC','BEHAVIOURAL','WELLBEING','GENERAL'))
);
CREATE INDEX IF NOT EXISTS sis_student_notes_student_created_idx ON sis_student_notes(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sis_student_notes_author_created_idx ON sis_student_notes(author_id, created_at DESC);
ALTER TABLE sis_enrollments DROP CONSTRAINT IF EXISTS sis_enrollments_student_id_fkey;
ALTER TABLE sis_enrollments ADD CONSTRAINT sis_enrollments_student_id_fkey FOREIGN KEY (student_id) REFERENCES sis_students(id)
