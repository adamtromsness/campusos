CREATE TABLE IF NOT EXISTS sis_absence_requests (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    student_id UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
    submitted_by UUID NOT NULL REFERENCES platform.platform_users(id),
    absence_date_from DATE NOT NULL,
    absence_date_to DATE NOT NULL,
    request_type TEXT NOT NULL,
    reason_category TEXT NOT NULL,
    reason_text TEXT NOT NULL,
    supporting_document_s3_key TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    reviewed_by UUID REFERENCES platform.platform_users(id),
    reviewed_at TIMESTAMPTZ,
    reviewer_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sis_absence_requests_request_type_chk CHECK (request_type IN ('SAME_DAY_REPORT','ADVANCE_REQUEST')),
    CONSTRAINT sis_absence_requests_reason_chk CHECK (reason_category IN ('ILLNESS','MEDICAL_APPOINTMENT','FAMILY_EMERGENCY','HOLIDAY','RELIGIOUS_OBSERVANCE','OTHER')),
    CONSTRAINT sis_absence_requests_status_chk CHECK (status IN ('PENDING','APPROVED','REJECTED','AUTO_APPROVED')),
    CONSTRAINT sis_absence_requests_dates_chk CHECK (absence_date_to >= absence_date_from),
    CONSTRAINT sis_absence_requests_review_consistency_chk CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS sis_absence_requests_student_date_idx ON sis_absence_requests(student_id, absence_date_from);
CREATE INDEX IF NOT EXISTS sis_absence_requests_school_pending_idx ON sis_absence_requests(school_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS sis_absence_requests_submitted_by_idx ON sis_absence_requests(submitted_by);
CREATE TABLE IF NOT EXISTS sis_attendance_records (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    school_year DATE NOT NULL,
    student_id UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
    class_id UUID NOT NULL REFERENCES sis_classes(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    period TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PRESENT',
    confirmation_status TEXT NOT NULL DEFAULT 'PRE_POPULATED',
    evidence_source TEXT,
    marked_by UUID REFERENCES platform.platform_users(id),
    marked_at TIMESTAMPTZ,
    parent_explanation TEXT,
    parent_explained_at TIMESTAMPTZ,
    absence_request_id UUID REFERENCES sis_absence_requests(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sis_attendance_records_status_chk CHECK (status IN ('PRESENT','ABSENT','TARDY','EARLY_DEPARTURE','EXCUSED')),
    CONSTRAINT sis_attendance_records_confirmation_chk CHECK (confirmation_status IN ('PRE_POPULATED','CONFIRMED')),
    CONSTRAINT sis_attendance_records_evidence_source_chk CHECK (evidence_source IS NULL OR evidence_source IN ('BUS_SCAN','DOOR_SCAN','MANUAL_CHECKIN','PREVIOUS_PERIOD','SYSTEM_INFERRED')),
    CONSTRAINT sis_attendance_records_natural_uq UNIQUE (student_id, class_id, date, period)
);
CREATE INDEX IF NOT EXISTS sis_attendance_records_class_date_idx ON sis_attendance_records(class_id, date);
CREATE INDEX IF NOT EXISTS sis_attendance_records_student_date_idx ON sis_attendance_records(student_id, date);
CREATE INDEX IF NOT EXISTS sis_attendance_records_school_date_idx ON sis_attendance_records(school_id, date);
CREATE INDEX IF NOT EXISTS sis_attendance_records_absence_request_idx ON sis_attendance_records(absence_request_id) WHERE absence_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sis_attendance_records_unconfirmed_idx ON sis_attendance_records(class_id, date) WHERE confirmation_status = 'PRE_POPULATED';
CREATE TABLE IF NOT EXISTS sis_attendance_evidence (
    id UUID PRIMARY KEY,
    record_id UUID NOT NULL REFERENCES sis_attendance_records(id) ON DELETE CASCADE,
    evidence_type TEXT NOT NULL,
    source_ref_id UUID,
    note_text TEXT,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sis_attendance_evidence_type_chk CHECK (evidence_type IN ('BUS_SCAN','DOOR_SCAN','PHOTO','NOTE'))
);
CREATE INDEX IF NOT EXISTS sis_attendance_evidence_record_idx ON sis_attendance_evidence(record_id)
