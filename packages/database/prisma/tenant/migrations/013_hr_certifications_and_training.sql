/* 013_hr_certifications_and_training.sql
 * Cycle 4 Step 3 — Certifications, training compliance, CPD, work authorisation.
 *
 * Five tables:
 *   hr_staff_certifications — per-employee certification records (Teaching
 *                              Licence, First Aid, Safeguarding, DBS, etc).
 *                              ADR-015 — for DBS / background-check refs we
 *                              store only the reference number plus the
 *                              verification status, never the underlying
 *                              record content. The document_s3_key column
 *                              points at a scanned cert PDF, not raw DBS data.
 *   hr_training_requirements — per-school training mandates. position_id
 *                              NULL means the requirement applies to every
 *                              staff member, not just one position. Linked
 *                              to a certification_type so the compliance
 *                              worker can resolve "this employee holds a
 *                              VERIFIED Safeguarding Level 1 cert" to
 *                              "compliant on the Safeguarding requirement".
 *   hr_training_compliance — materialised per-(employee, requirement)
 *                            compliance state. Updated nightly by
 *                            TrainingComplianceWorker (lands in Step 7).
 *                            UNIQUE on the pair so the worker can do an
 *                            UPSERT without contention.
 *   hr_cpd_requirements — per-(school, position, academic_year) PD-hour
 *                          and credit-hour mandates. UNIQUE on the triple.
 *   hr_work_authorisation — per-employee right-to-work record. UNIQUE on
 *                            employee_id. expiry_date drives the
 *                            reverification reminder pipeline.
 *
 * DB-enforced FKs: every employee reference is to hr_employees ON DELETE
 * CASCADE. position_id refs hr_positions (non-cascade). academic_year_id
 * refs sis_academic_years (non-cascade). hr_training_compliance carries a
 * linked_certification_id FK to hr_staff_certifications ON DELETE SET NULL
 * so a deleted certification leaves the compliance row in a defensible
 * "not satisfied by any cert" state rather than dropping the row outright.
 *
 * Block-comment style required per the splitter quirk. No semicolons inside
 * any string literal or block comment — splitter cuts on every semicolon.
 * Idempotent — safe to re-run.
 */
CREATE TABLE IF NOT EXISTS hr_staff_certifications (
    id UUID PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    certification_type TEXT NOT NULL,
    certification_name TEXT NOT NULL,
    issuing_body TEXT,
    reference_number TEXT,
    issued_date DATE,
    expiry_date DATE,
    verification_status TEXT NOT NULL DEFAULT 'PENDING',
    verified_by UUID,
    verified_at TIMESTAMPTZ,
    document_s3_key TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_staff_certifications_type_chk CHECK (certification_type IN (
        'TEACHING_LICENCE',
        'FIRST_AID',
        'SAFEGUARDING_LEVEL1',
        'SAFEGUARDING_LEVEL2',
        'DBS_BASIC',
        'DBS_ENHANCED',
        'FOOD_HYGIENE',
        'FIRE_SAFETY_WARDEN',
        'SPECIALIST_SUBJECT',
        'CUSTOM'
    )),
    CONSTRAINT hr_staff_certifications_status_chk CHECK (verification_status IN ('PENDING','VERIFIED','EXPIRED','REVOKED')),
    CONSTRAINT hr_staff_certifications_dates_chk CHECK (expiry_date IS NULL OR issued_date IS NULL OR expiry_date >= issued_date)
);
CREATE INDEX IF NOT EXISTS hr_staff_certifications_employee_idx ON hr_staff_certifications(employee_id, certification_type);
CREATE INDEX IF NOT EXISTS hr_staff_certifications_expiry_idx ON hr_staff_certifications(expiry_date) WHERE expiry_date IS NOT NULL AND verification_status IN ('PENDING','VERIFIED');
CREATE INDEX IF NOT EXISTS hr_staff_certifications_status_idx ON hr_staff_certifications(verification_status) WHERE verification_status = 'PENDING';
COMMENT ON COLUMN hr_staff_certifications.reference_number IS 'ADR-015 — for DBS or other regulated background-check certs, store only the reference number plus the verification status. The underlying record content lives outside CampusOS. Free-text reference for non-regulated certs (e.g. teaching licence number).';
COMMENT ON COLUMN hr_staff_certifications.document_s3_key IS 'Object key in the school document bucket pointing at a scanned cert PDF. Never contains raw DBS data — see ADR-015.';
COMMENT ON COLUMN hr_staff_certifications.verified_by IS 'Soft FK to platform.platform_users(id) per ADR-055 — the admin who verified the certification.';
CREATE TABLE IF NOT EXISTS hr_training_requirements (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    position_id UUID REFERENCES hr_positions(id),
    training_name TEXT NOT NULL,
    description TEXT,
    certification_type TEXT,
    frequency TEXT NOT NULL,
    custom_frequency_months INT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_training_requirements_frequency_chk CHECK (frequency IN ('ONE_TIME','ANNUAL','BIENNIAL','TRIENNIAL','CUSTOM')),
    CONSTRAINT hr_training_requirements_custom_chk CHECK (
        (frequency <> 'CUSTOM' AND custom_frequency_months IS NULL)
        OR
        (frequency = 'CUSTOM' AND custom_frequency_months IS NOT NULL AND custom_frequency_months > 0)
    ),
    CONSTRAINT hr_training_requirements_cert_type_chk CHECK (certification_type IS NULL OR certification_type IN (
        'TEACHING_LICENCE',
        'FIRST_AID',
        'SAFEGUARDING_LEVEL1',
        'SAFEGUARDING_LEVEL2',
        'DBS_BASIC',
        'DBS_ENHANCED',
        'FOOD_HYGIENE',
        'FIRE_SAFETY_WARDEN',
        'SPECIALIST_SUBJECT',
        'CUSTOM'
    )),
    CONSTRAINT hr_training_requirements_school_name_position_uq UNIQUE (school_id, training_name, position_id)
);
CREATE INDEX IF NOT EXISTS hr_training_requirements_school_active_idx ON hr_training_requirements(school_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS hr_training_requirements_position_idx ON hr_training_requirements(position_id) WHERE position_id IS NOT NULL;
COMMENT ON COLUMN hr_training_requirements.position_id IS 'NULL means the requirement applies to every staff member at the school. Set to a specific hr_positions row to scope it to a single position.';
COMMENT ON COLUMN hr_training_requirements.certification_type IS 'When set, the compliance worker resolves the requirement against any VERIFIED, non-expired hr_staff_certifications row of this type for the employee. NULL means compliance is tracked manually.';
CREATE TABLE IF NOT EXISTS hr_training_compliance (
    id UUID PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    requirement_id UUID NOT NULL REFERENCES hr_training_requirements(id) ON DELETE CASCADE,
    is_compliant BOOLEAN NOT NULL DEFAULT false,
    last_completed_date DATE,
    next_due_date DATE,
    linked_certification_id UUID REFERENCES hr_staff_certifications(id) ON DELETE SET NULL,
    days_until_due INT,
    last_evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_training_compliance_employee_requirement_uq UNIQUE (employee_id, requirement_id)
);
CREATE INDEX IF NOT EXISTS hr_training_compliance_due_idx ON hr_training_compliance(next_due_date) WHERE next_due_date IS NOT NULL AND is_compliant = false;
CREATE INDEX IF NOT EXISTS hr_training_compliance_employee_idx ON hr_training_compliance(employee_id, is_compliant);
COMMENT ON COLUMN hr_training_compliance.days_until_due IS 'Materialised by TrainingComplianceWorker (Step 7). Negative when overdue. NULL when next_due_date is unknown (e.g. ONE_TIME requirement that has never been completed).';
COMMENT ON COLUMN hr_training_compliance.linked_certification_id IS 'When the requirement carries a certification_type, this points at the specific hr_staff_certifications row that satisfied it. ON DELETE SET NULL so a removed cert leaves the compliance row in a clean not-satisfied state instead of vanishing.';
CREATE TABLE IF NOT EXISTS hr_cpd_requirements (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    position_id UUID REFERENCES hr_positions(id),
    academic_year_id UUID NOT NULL REFERENCES sis_academic_years(id),
    required_pd_hours NUMERIC(4,1) NOT NULL DEFAULT 0.0,
    required_credit_hours NUMERIC(4,1) NOT NULL DEFAULT 0.0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_cpd_requirements_school_position_year_uq UNIQUE (school_id, position_id, academic_year_id),
    CONSTRAINT hr_cpd_requirements_pd_hours_chk CHECK (required_pd_hours >= 0),
    CONSTRAINT hr_cpd_requirements_credit_hours_chk CHECK (required_credit_hours >= 0)
);
CREATE INDEX IF NOT EXISTS hr_cpd_requirements_year_idx ON hr_cpd_requirements(academic_year_id);
COMMENT ON COLUMN hr_cpd_requirements.position_id IS 'NULL means the CPD mandate applies to every staff member at the school for this academic year. Scoping by position lets schools differentiate teacher vs admin PD obligations.';
CREATE TABLE IF NOT EXISTS hr_work_authorisation (
    id UUID PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
    document_type TEXT NOT NULL,
    document_reference TEXT,
    issued_date DATE,
    expiry_date DATE,
    verified_by UUID,
    verified_at DATE,
    reverification_due_date DATE,
    document_s3_key TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hr_work_authorisation_employee_uq UNIQUE (employee_id),
    CONSTRAINT hr_work_authorisation_type_chk CHECK (document_type IN (
        'US_PASSPORT',
        'UK_PASSPORT',
        'UK_BRP',
        'PERMANENT_RESIDENT_CARD',
        'EMPLOYMENT_AUTHORISATION',
        'OTHER'
    )),
    CONSTRAINT hr_work_authorisation_dates_chk CHECK (expiry_date IS NULL OR issued_date IS NULL OR expiry_date >= issued_date)
);
CREATE INDEX IF NOT EXISTS hr_work_authorisation_reverification_idx ON hr_work_authorisation(reverification_due_date) WHERE reverification_due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS hr_work_authorisation_expiry_idx ON hr_work_authorisation(expiry_date) WHERE expiry_date IS NOT NULL;
COMMENT ON COLUMN hr_work_authorisation.document_reference IS 'Free-text reference (passport number, BRP number, EAD case number). ADR-015 — store reference only, never raw document content. The scanned image lives in document_s3_key.';
COMMENT ON COLUMN hr_work_authorisation.verified_by IS 'Soft FK to platform.platform_users(id) per ADR-055.';
COMMENT ON COLUMN hr_work_authorisation.reverification_due_date IS 'When right-to-work needs to be re-verified, distinct from expiry_date. Some employment authorisations require re-verification on a different cadence than the document expiry.';
