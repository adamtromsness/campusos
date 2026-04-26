CREATE TABLE IF NOT EXISTS sis_absence_requests (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    student_id UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
    submitted_by UUID NOT NULL,
    absence_date_from DATE NOT NULL,
    absence_date_to DATE NOT NULL,
    request_type TEXT NOT NULL,
    reason_category TEXT NOT NULL,
    reason_text TEXT NOT NULL,
    supporting_document_s3_key TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    reviewed_by UUID,
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
    id UUID NOT NULL,
    school_id UUID NOT NULL,
    school_year DATE NOT NULL,
    student_id UUID NOT NULL,
    class_id UUID NOT NULL,
    date DATE NOT NULL,
    period TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PRESENT',
    confirmation_status TEXT NOT NULL DEFAULT 'PRE_POPULATED',
    evidence_source TEXT,
    marked_by UUID,
    marked_at TIMESTAMPTZ,
    parent_explanation TEXT,
    parent_explained_at TIMESTAMPTZ,
    absence_request_id UUID REFERENCES sis_absence_requests(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sis_attendance_records_pk PRIMARY KEY (id, school_year, class_id),
    CONSTRAINT sis_attendance_records_status_chk CHECK (status IN ('PRESENT','ABSENT','TARDY','EARLY_DEPARTURE','EXCUSED')),
    CONSTRAINT sis_attendance_records_confirmation_chk CHECK (confirmation_status IN ('PRE_POPULATED','CONFIRMED')),
    CONSTRAINT sis_attendance_records_evidence_source_chk CHECK (evidence_source IS NULL OR evidence_source IN ('BUS_SCAN','DOOR_SCAN','MANUAL_CHECKIN','PREVIOUS_PERIOD','SYSTEM_INFERRED')),
    CONSTRAINT sis_attendance_records_natural_uq UNIQUE (school_year, class_id, student_id, date, period)
) PARTITION BY RANGE (school_year);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2024_25 PARTITION OF sis_attendance_records FOR VALUES FROM ('2024-08-01') TO ('2025-08-01') PARTITION BY HASH (class_id);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2024_25_h0 PARTITION OF sis_attendance_records_2024_25 FOR VALUES WITH (MODULUS 8, REMAINDER 0);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2024_25_h1 PARTITION OF sis_attendance_records_2024_25 FOR VALUES WITH (MODULUS 8, REMAINDER 1);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2024_25_h2 PARTITION OF sis_attendance_records_2024_25 FOR VALUES WITH (MODULUS 8, REMAINDER 2);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2024_25_h3 PARTITION OF sis_attendance_records_2024_25 FOR VALUES WITH (MODULUS 8, REMAINDER 3);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2024_25_h4 PARTITION OF sis_attendance_records_2024_25 FOR VALUES WITH (MODULUS 8, REMAINDER 4);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2024_25_h5 PARTITION OF sis_attendance_records_2024_25 FOR VALUES WITH (MODULUS 8, REMAINDER 5);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2024_25_h6 PARTITION OF sis_attendance_records_2024_25 FOR VALUES WITH (MODULUS 8, REMAINDER 6);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2024_25_h7 PARTITION OF sis_attendance_records_2024_25 FOR VALUES WITH (MODULUS 8, REMAINDER 7);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2025_26 PARTITION OF sis_attendance_records FOR VALUES FROM ('2025-08-01') TO ('2026-08-01') PARTITION BY HASH (class_id);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2025_26_h0 PARTITION OF sis_attendance_records_2025_26 FOR VALUES WITH (MODULUS 8, REMAINDER 0);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2025_26_h1 PARTITION OF sis_attendance_records_2025_26 FOR VALUES WITH (MODULUS 8, REMAINDER 1);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2025_26_h2 PARTITION OF sis_attendance_records_2025_26 FOR VALUES WITH (MODULUS 8, REMAINDER 2);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2025_26_h3 PARTITION OF sis_attendance_records_2025_26 FOR VALUES WITH (MODULUS 8, REMAINDER 3);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2025_26_h4 PARTITION OF sis_attendance_records_2025_26 FOR VALUES WITH (MODULUS 8, REMAINDER 4);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2025_26_h5 PARTITION OF sis_attendance_records_2025_26 FOR VALUES WITH (MODULUS 8, REMAINDER 5);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2025_26_h6 PARTITION OF sis_attendance_records_2025_26 FOR VALUES WITH (MODULUS 8, REMAINDER 6);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2025_26_h7 PARTITION OF sis_attendance_records_2025_26 FOR VALUES WITH (MODULUS 8, REMAINDER 7);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2026_27 PARTITION OF sis_attendance_records FOR VALUES FROM ('2026-08-01') TO ('2027-08-01') PARTITION BY HASH (class_id);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2026_27_h0 PARTITION OF sis_attendance_records_2026_27 FOR VALUES WITH (MODULUS 8, REMAINDER 0);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2026_27_h1 PARTITION OF sis_attendance_records_2026_27 FOR VALUES WITH (MODULUS 8, REMAINDER 1);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2026_27_h2 PARTITION OF sis_attendance_records_2026_27 FOR VALUES WITH (MODULUS 8, REMAINDER 2);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2026_27_h3 PARTITION OF sis_attendance_records_2026_27 FOR VALUES WITH (MODULUS 8, REMAINDER 3);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2026_27_h4 PARTITION OF sis_attendance_records_2026_27 FOR VALUES WITH (MODULUS 8, REMAINDER 4);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2026_27_h5 PARTITION OF sis_attendance_records_2026_27 FOR VALUES WITH (MODULUS 8, REMAINDER 5);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2026_27_h6 PARTITION OF sis_attendance_records_2026_27 FOR VALUES WITH (MODULUS 8, REMAINDER 6);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2026_27_h7 PARTITION OF sis_attendance_records_2026_27 FOR VALUES WITH (MODULUS 8, REMAINDER 7);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2027_28 PARTITION OF sis_attendance_records FOR VALUES FROM ('2027-08-01') TO ('2028-08-01') PARTITION BY HASH (class_id);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2027_28_h0 PARTITION OF sis_attendance_records_2027_28 FOR VALUES WITH (MODULUS 8, REMAINDER 0);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2027_28_h1 PARTITION OF sis_attendance_records_2027_28 FOR VALUES WITH (MODULUS 8, REMAINDER 1);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2027_28_h2 PARTITION OF sis_attendance_records_2027_28 FOR VALUES WITH (MODULUS 8, REMAINDER 2);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2027_28_h3 PARTITION OF sis_attendance_records_2027_28 FOR VALUES WITH (MODULUS 8, REMAINDER 3);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2027_28_h4 PARTITION OF sis_attendance_records_2027_28 FOR VALUES WITH (MODULUS 8, REMAINDER 4);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2027_28_h5 PARTITION OF sis_attendance_records_2027_28 FOR VALUES WITH (MODULUS 8, REMAINDER 5);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2027_28_h6 PARTITION OF sis_attendance_records_2027_28 FOR VALUES WITH (MODULUS 8, REMAINDER 6);
CREATE TABLE IF NOT EXISTS sis_attendance_records_2027_28_h7 PARTITION OF sis_attendance_records_2027_28 FOR VALUES WITH (MODULUS 8, REMAINDER 7);
CREATE INDEX IF NOT EXISTS sis_attendance_records_class_date_idx ON sis_attendance_records(class_id, date);
CREATE INDEX IF NOT EXISTS sis_attendance_records_student_date_idx ON sis_attendance_records(student_id, date);
CREATE INDEX IF NOT EXISTS sis_attendance_records_school_date_idx ON sis_attendance_records(school_id, date);
CREATE INDEX IF NOT EXISTS sis_attendance_records_absence_request_idx ON sis_attendance_records(absence_request_id) WHERE absence_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sis_attendance_records_unconfirmed_idx ON sis_attendance_records(class_id, date) WHERE confirmation_status = 'PRE_POPULATED';
CREATE INDEX IF NOT EXISTS sis_attendance_records_date_brin_idx ON sis_attendance_records USING BRIN (date);
CREATE TABLE IF NOT EXISTS sis_attendance_evidence (
    id UUID PRIMARY KEY,
    record_id UUID NOT NULL,
    record_school_year DATE NOT NULL,
    record_class_id UUID NOT NULL,
    evidence_type TEXT NOT NULL,
    source_ref_id UUID,
    note_text TEXT,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sis_attendance_evidence_type_chk CHECK (evidence_type IN ('BUS_SCAN','DOOR_SCAN','PHOTO','NOTE'))
);
CREATE INDEX IF NOT EXISTS sis_attendance_evidence_record_idx ON sis_attendance_evidence(record_id, record_school_year, record_class_id)
