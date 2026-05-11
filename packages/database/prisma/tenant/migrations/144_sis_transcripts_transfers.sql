/*
 * 144_sis_transcripts_transfers.sql — Phase 2 Cycle 13 sub-cycle c (P2-13c).
 *
 * M20 SIS Advanced — final 8 of 24 tables. The P2-13 cycle ships
 * 24 tables across 3 sub-cycles (P2-13a 8 plus P2-13b 8 plus
 * P2-13c 8). Migration 144 covers P2-13c transcripts plus transfers
 * plus lockers plus reporting periods plus awards plus medical
 * exemptions.
 *
 *   sis_transcripts                 Official or unofficial
 *                                   transcript header. 2-value
 *                                   transcript_type CHECK (OFFICIAL
 *                                   UNOFFICIAL). 3-value status
 *                                   CHECK (GENERATED SENT REVOKED).
 *                                   cumulative_gpa_snapshot plus
 *                                   total_credits plus class_rank
 *                                   plus class_size frozen at
 *                                   generation time so a future
 *                                   re-grade does not rewrite the
 *                                   official record.
 *   sis_transcript_courses          THE FROZEN-SNAPSHOT KEYSTONE.
 *                                   One row per course on the
 *                                   transcript at generation time.
 *                                   academic_year plus term plus
 *                                   course_name plus course_code
 *                                   plus credits plus grade plus
 *                                   grade_points plus is_honors
 *                                   plus is_ap all copied from
 *                                   cls_grades joined to sis_classes
 *                                   plus sis_courses at the moment
 *                                   the transcript is generated.
 *                                   NEVER a live join — once the
 *                                   transcript exists the courses
 *                                   are immutable. A re-grade
 *                                   downstream creates a new
 *                                   transcript with fresh frozen
 *                                   rows — it does NOT rewrite the
 *                                   old one.
 *   sis_transcript_requests         Parent or student request for
 *                                   an official or unofficial
 *                                   transcript with recipient
 *                                   details. 2-value transcript_type
 *                                   CHECK. 5-value status CHECK
 *                                   (SUBMITTED PROCESSING SENT
 *                                   PICKED_UP CANCELLED).
 *                                   fee_amount plus fee_paid plus
 *                                   linked_invoice_id soft to
 *                                   pay_invoices for the optional
 *                                   transcript fee path —
 *                                   TranscriptService creates the
 *                                   pay_invoice when fee_amount is
 *                                   set.
 *   sis_transfer_records            Incoming or outgoing transfer
 *                                   between schools. 2-value
 *                                   transfer_direction CHECK
 *                                   (INCOMING OUTGOING).
 *                                   records_received plus
 *                                   records_sent flags drive the
 *                                   admin checklist. Multi-column
 *                                   direction_chk enforces an
 *                                   INCOMING transfer carries
 *                                   records_received (not _sent)
 *                                   and an OUTGOING transfer
 *                                   carries records_sent (not
 *                                   _received).
 *   sis_lockers                     Locker assignment. 3-value
 *                                   status CHECK (AVAILABLE
 *                                   ASSIGNED OUT_OF_SERVICE).
 *                                   combination_encrypted holds
 *                                   AES-256-GCM ciphertext of the
 *                                   combination string in the
 *                                   project standard wire format
 *                                   base64(iv).base64(tag).base64
 *                                   (ciphertext). The plaintext
 *                                   combination is never stored.
 *                                   Multi-column assignment_chk
 *                                   keeps assigned_to_student_id
 *                                   plus assigned_at plus
 *                                   academic_year populated together
 *                                   when status equals ASSIGNED,
 *                                   and all three NULL when status
 *                                   equals AVAILABLE.
 *   sis_reporting_periods           Per-(school, academic_year)
 *                                   grading window. 4-value
 *                                   period_type CHECK
 *                                   (PROGRESS_REPORT REPORT_CARD
 *                                   INTERIM FINAL). 4-value status
 *                                   CHECK (UPCOMING OPEN
 *                                   GRADING_CLOSED PUBLISHED).
 *                                   Service-layer enforces a strict
 *                                   transition graph UPCOMING to
 *                                   OPEN to GRADING_CLOSED to
 *                                   PUBLISHED — no skipping
 *                                   forward, no walking backward.
 *   sis_student_awards              Student award record. 6-value
 *                                   award_type CHECK (HONOR_ROLL
 *                                   DEANS_LIST PERFECT_ATTENDANCE
 *                                   SUBJECT_AWARD CITIZENSHIP
 *                                   OTHER). awarded_by soft FK to
 *                                   platform.iam_person per
 *                                   ADR-001 and ADR-020.
 *   sis_medical_exemption_records   Per-student medical exemption
 *                                   from PE, swimming, field trips,
 *                                   etc. 4-value exemption_type
 *                                   CHECK (PE SWIMMING FIELD_TRIP
 *                                   OTHER). doctor_note_s3_key
 *                                   carries the signed doctor's
 *                                   note. effective_from plus
 *                                   effective_to define the date
 *                                   range — effective_to NULL means
 *                                   the exemption is open-ended.
 *                                   Multi-column dates_chk enforces
 *                                   effective_to greater than or
 *                                   equal to effective_from when
 *                                   both are set.
 *
 * Cross-cycle integration:
 *   - sis_transcripts.gpa_config_id refers to sis_gpa_configurations
 *     (P2-13b migration 143) as a soft FK per ADR-001 and ADR-020.
 *   - sis_transcript_requests.linked_invoice_id refers to pay_invoices
 *     (Cycle 6 migration 124) as a soft FK per ADR-001 and ADR-020.
 *     TranscriptService creates the pay_invoice when fee_amount is
 *     set so the family pays via the normal billing flow.
 *   - sis_transfer_records.student_id is the DB-enforced FK to
 *     sis_students CASCADE — the schema treats the transfer record
 *     as a child of the student.
 *   - sis_lockers.assigned_to_student_id is a soft FK to sis_students
 *     per ADR-001 and ADR-020. Year-end bulk clear sets the column
 *     plus status plus assigned_at plus academic_year all back to
 *     NULL and AVAILABLE in one tx via the bulk-clear endpoint.
 *   - sis_reporting_periods.academic_year_id is a soft FK to
 *     sis_academic_years per ADR-001 and ADR-020.
 *
 * No cross-schema FKs introduced by migration 144.
 *
 * COMMENTs and CHECK strings avoid bare semicolons mid-comment per
 * the documented Cycle 4-onwards splitter convention.
 */

CREATE TABLE IF NOT EXISTS sis_transcripts (
  id                          UUID PRIMARY KEY,
  student_id                  UUID NOT NULL,
  transcript_type             TEXT NOT NULL,
  generated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_by                UUID NOT NULL,
  gpa_config_id               UUID NOT NULL,
  cumulative_gpa_snapshot     NUMERIC(4,3),
  total_credits               NUMERIC(5,2),
  class_rank                  INT,
  class_size                  INT,
  pdf_s3_key                  TEXT,
  recipient_name              TEXT,
  recipient_address           TEXT,
  recipient_email             TEXT,
  linked_request_id           UUID,
  status                      TEXT NOT NULL DEFAULT 'GENERATED',
  sent_at                     TIMESTAMPTZ,
  revoked_at                  TIMESTAMPTZ,
  revoke_reason               TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_transcripts_student_fk FOREIGN KEY (student_id)
    REFERENCES sis_students(id) ON DELETE CASCADE,
  CONSTRAINT sis_transcripts_type_chk CHECK (
    transcript_type IN ('OFFICIAL','UNOFFICIAL')
  ),
  CONSTRAINT sis_transcripts_status_chk CHECK (
    status IN ('GENERATED','SENT','REVOKED')
  ),
  CONSTRAINT sis_transcripts_sent_chk CHECK (
    (status = 'GENERATED' AND sent_at IS NULL)
    OR (status IN ('SENT','REVOKED'))
  ),
  CONSTRAINT sis_transcripts_revoked_chk CHECK (
    (status <> 'REVOKED' AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (status = 'REVOKED' AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
  ),
  CONSTRAINT sis_transcripts_rank_chk CHECK (
    (class_rank IS NULL OR class_rank > 0)
    AND (class_size IS NULL OR class_size > 0)
  )
);

CREATE INDEX IF NOT EXISTS sis_transcripts_student_idx
  ON sis_transcripts(student_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS sis_transcripts_type_idx
  ON sis_transcripts(transcript_type, status);

COMMENT ON TABLE sis_transcripts IS
  'Official or unofficial transcript header. cumulative_gpa_snapshot plus total_credits plus class_rank plus class_size frozen at generation time so a future grade change downstream does not rewrite an issued transcript. 3-value status CHECK with multi-column sent_chk plus revoked_chk lockstep.';

COMMENT ON COLUMN sis_transcripts.generated_by IS
  'Soft FK to platform.iam_person(id) per ADR-001 and ADR-020. Identifies the registrar who issued the transcript.';

COMMENT ON COLUMN sis_transcripts.gpa_config_id IS
  'Soft FK to sis_gpa_configurations(id) per ADR-001 and ADR-020. The GPA configuration used to compute cumulative_gpa_snapshot at generation time. P2-13b shipped sis_gpa_configurations.';

COMMENT ON COLUMN sis_transcripts.linked_request_id IS
  'Soft FK to sis_transcript_requests(id) per ADR-001 and ADR-020. Populated when the transcript was generated to fulfil a request. NULL when the registrar generated it directly.';

CREATE TABLE IF NOT EXISTS sis_transcript_courses (
  id                       UUID PRIMARY KEY,
  transcript_id            UUID NOT NULL,
  academic_year            TEXT NOT NULL,
  term                     TEXT NOT NULL,
  course_name              TEXT NOT NULL,
  course_code              TEXT,
  credits                  NUMERIC(3,1),
  grade                    TEXT NOT NULL,
  grade_points             NUMERIC(3,1),
  is_honors                BOOLEAN NOT NULL DEFAULT false,
  is_ap                    BOOLEAN NOT NULL DEFAULT false,
  source_class_id          UUID,
  sort_order               INT NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_transcript_courses_transcript_fk FOREIGN KEY (transcript_id)
    REFERENCES sis_transcripts(id) ON DELETE CASCADE,
  CONSTRAINT sis_transcript_courses_credits_chk CHECK (
    credits IS NULL OR credits >= 0
  ),
  CONSTRAINT sis_transcript_courses_points_chk CHECK (
    grade_points IS NULL OR grade_points >= 0
  )
);

CREATE INDEX IF NOT EXISTS sis_transcript_courses_transcript_idx
  ON sis_transcript_courses(transcript_id, sort_order);

CREATE INDEX IF NOT EXISTS sis_transcript_courses_year_term_idx
  ON sis_transcript_courses(transcript_id, academic_year, term);

COMMENT ON TABLE sis_transcript_courses IS
  'THE FROZEN-SNAPSHOT KEYSTONE. Course-by-course copy of cls_grades joined to sis_classes plus sis_courses at the moment the parent transcript is generated. NEVER a live join — once the row exists the data is immutable. A re-grade downstream creates a NEW transcript with fresh rows and does NOT rewrite the existing rows.';

COMMENT ON COLUMN sis_transcript_courses.source_class_id IS
  'Soft FK to sis_classes(id) per ADR-001 and ADR-020. Records the originating class for traceability without binding the snapshot to live data. The row stands alone if the class is later deleted or modified.';

CREATE TABLE IF NOT EXISTS sis_transcript_requests (
  id                       UUID PRIMARY KEY,
  student_id               UUID NOT NULL,
  requested_by             UUID NOT NULL,
  recipient_name           TEXT NOT NULL,
  recipient_address        TEXT,
  recipient_email          TEXT,
  transcript_type          TEXT NOT NULL,
  copies                   INT NOT NULL DEFAULT 1,
  fee_amount               NUMERIC(6,2),
  fee_paid                 BOOLEAN NOT NULL DEFAULT false,
  linked_invoice_id        UUID,
  status                   TEXT NOT NULL DEFAULT 'SUBMITTED',
  notes                    TEXT,
  processed_at             TIMESTAMPTZ,
  sent_at                  TIMESTAMPTZ,
  picked_up_at             TIMESTAMPTZ,
  cancelled_at             TIMESTAMPTZ,
  cancel_reason            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_transcript_req_student_fk FOREIGN KEY (student_id)
    REFERENCES sis_students(id) ON DELETE CASCADE,
  CONSTRAINT sis_transcript_req_type_chk CHECK (
    transcript_type IN ('OFFICIAL','UNOFFICIAL')
  ),
  CONSTRAINT sis_transcript_req_status_chk CHECK (
    status IN ('SUBMITTED','PROCESSING','SENT','PICKED_UP','CANCELLED')
  ),
  CONSTRAINT sis_transcript_req_copies_chk CHECK (copies > 0 AND copies <= 50),
  CONSTRAINT sis_transcript_req_fee_chk CHECK (
    fee_amount IS NULL OR fee_amount >= 0
  ),
  CONSTRAINT sis_transcript_req_cancelled_chk CHECK (
    (status <> 'CANCELLED' AND cancelled_at IS NULL AND cancel_reason IS NULL)
    OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS sis_transcript_req_student_idx
  ON sis_transcript_requests(student_id, status);

CREATE INDEX IF NOT EXISTS sis_transcript_req_status_idx
  ON sis_transcript_requests(status, created_at DESC) WHERE status IN ('SUBMITTED','PROCESSING');

COMMENT ON TABLE sis_transcript_requests IS
  'Parent or student request for an official or unofficial transcript. 2-value transcript_type CHECK plus 5-value status CHECK. fee_amount plus fee_paid plus linked_invoice_id soft FK to pay_invoices drive the fee-collection path — TranscriptService creates the pay_invoice when fee_amount is set so the family pays through the standard billing flow.';

COMMENT ON COLUMN sis_transcript_requests.requested_by IS
  'Soft FK to platform.iam_person(id) per ADR-001 and ADR-020. Identifies the parent or student who submitted the request.';

COMMENT ON COLUMN sis_transcript_requests.linked_invoice_id IS
  'Soft FK to pay_invoices(id) per ADR-001 and ADR-020. Populated when fee_amount is set and TranscriptService creates the matching pay_invoice. Family pays the invoice through the normal Cycle 6 billing flow and the resulting pay_payment flips fee_paid to true.';

CREATE TABLE IF NOT EXISTS sis_transfer_records (
  id                       UUID PRIMARY KEY,
  student_id               UUID NOT NULL,
  transfer_direction       TEXT NOT NULL,
  other_school_name        TEXT NOT NULL,
  other_school_country     TEXT,
  other_school_contact     TEXT,
  transfer_date            DATE NOT NULL,
  records_received         BOOLEAN NOT NULL DEFAULT false,
  records_sent             BOOLEAN NOT NULL DEFAULT false,
  records_package_s3_key   TEXT,
  notes                    TEXT,
  recorded_by              UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_transfer_student_fk FOREIGN KEY (student_id)
    REFERENCES sis_students(id) ON DELETE CASCADE,
  CONSTRAINT sis_transfer_direction_chk CHECK (
    transfer_direction IN ('INCOMING','OUTGOING')
  ),
  CONSTRAINT sis_transfer_records_shape_chk CHECK (
    (transfer_direction = 'INCOMING' AND records_sent = false)
    OR (transfer_direction = 'OUTGOING' AND records_received = false)
  )
);

CREATE INDEX IF NOT EXISTS sis_transfer_student_idx
  ON sis_transfer_records(student_id, transfer_date DESC);

CREATE INDEX IF NOT EXISTS sis_transfer_direction_idx
  ON sis_transfer_records(transfer_direction, transfer_date DESC);

COMMENT ON TABLE sis_transfer_records IS
  'Incoming or outgoing transfer between schools. 2-value transfer_direction CHECK with multi-column records_shape_chk enforcing INCOMING carries records_received only and OUTGOING carries records_sent only. records_package_s3_key links to the signed S3 object that holds the records package PDF.';

COMMENT ON COLUMN sis_transfer_records.recorded_by IS
  'Soft FK to platform.iam_person(id) per ADR-001 and ADR-020. Identifies the registrar who recorded the transfer.';

CREATE TABLE IF NOT EXISTS sis_lockers (
  id                          UUID PRIMARY KEY,
  school_id                   UUID NOT NULL,
  locker_number               TEXT NOT NULL,
  location_description        TEXT,
  combination_encrypted       TEXT,
  status                      TEXT NOT NULL DEFAULT 'AVAILABLE',
  assigned_to_student_id      UUID,
  assigned_at                 DATE,
  academic_year               TEXT,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_lockers_status_chk CHECK (
    status IN ('AVAILABLE','ASSIGNED','OUT_OF_SERVICE')
  ),
  CONSTRAINT sis_lockers_assignment_chk CHECK (
    (status = 'AVAILABLE' AND assigned_to_student_id IS NULL AND assigned_at IS NULL AND academic_year IS NULL)
    OR (status = 'ASSIGNED' AND assigned_to_student_id IS NOT NULL AND assigned_at IS NOT NULL AND academic_year IS NOT NULL)
    OR (status = 'OUT_OF_SERVICE' AND assigned_to_student_id IS NULL AND assigned_at IS NULL)
  ),
  CONSTRAINT sis_lockers_unique UNIQUE (school_id, locker_number)
);

CREATE INDEX IF NOT EXISTS sis_lockers_school_status_idx
  ON sis_lockers(school_id, status);

CREATE INDEX IF NOT EXISTS sis_lockers_available_idx
  ON sis_lockers(school_id) WHERE status = 'AVAILABLE';

CREATE INDEX IF NOT EXISTS sis_lockers_assigned_student_idx
  ON sis_lockers(assigned_to_student_id) WHERE assigned_to_student_id IS NOT NULL;

COMMENT ON TABLE sis_lockers IS
  'Locker assignment. 3-value status CHECK with multi-column assignment_chk lockstep — AVAILABLE requires every assignment column NULL, ASSIGNED requires all three populated together, OUT_OF_SERVICE allows academic_year NULL. combination_encrypted holds AES-256-GCM ciphertext in the project standard wire format base64(iv).base64(tag).base64(ciphertext). The plaintext combination is never stored. Year-end bulk clear resets every ASSIGNED locker to AVAILABLE in one tx.';

COMMENT ON COLUMN sis_lockers.combination_encrypted IS
  'AES-256-GCM ciphertext of the locker combination. Wire format mirrors Cycle 22 IT vault plus P2C1 visitor PII — base64(iv).base64(tag).base64(ciphertext). 12-byte iv plus 16-byte auth tag. The plaintext combination is generated by LockerService at assign time and never persisted.';

COMMENT ON COLUMN sis_lockers.assigned_to_student_id IS
  'Soft FK to sis_students(id) per ADR-001 and ADR-020. The student currently assigned to the locker. NULL when status equals AVAILABLE or OUT_OF_SERVICE.';

CREATE TABLE IF NOT EXISTS sis_reporting_periods (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  academic_year_id         UUID NOT NULL,
  name                     TEXT NOT NULL,
  period_type              TEXT NOT NULL,
  start_date               DATE NOT NULL,
  end_date                 DATE NOT NULL,
  grades_due_date          DATE NOT NULL,
  comments_due_date        DATE,
  status                   TEXT NOT NULL DEFAULT 'UPCOMING',
  published_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_reporting_period_type_chk CHECK (
    period_type IN ('PROGRESS_REPORT','REPORT_CARD','INTERIM','FINAL')
  ),
  CONSTRAINT sis_reporting_period_status_chk CHECK (
    status IN ('UPCOMING','OPEN','GRADING_CLOSED','PUBLISHED')
  ),
  CONSTRAINT sis_reporting_period_dates_chk CHECK (
    end_date >= start_date
    AND grades_due_date >= start_date
    AND (comments_due_date IS NULL OR comments_due_date >= start_date)
  ),
  CONSTRAINT sis_reporting_period_published_chk CHECK (
    (status = 'PUBLISHED' AND published_at IS NOT NULL)
    OR (status <> 'PUBLISHED' AND published_at IS NULL)
  ),
  CONSTRAINT sis_reporting_period_unique UNIQUE (school_id, academic_year_id, name)
);

CREATE INDEX IF NOT EXISTS sis_reporting_period_school_idx
  ON sis_reporting_periods(school_id, academic_year_id, start_date);

CREATE INDEX IF NOT EXISTS sis_reporting_period_status_idx
  ON sis_reporting_periods(school_id, status);

COMMENT ON TABLE sis_reporting_periods IS
  'Per-(school, academic_year) grading window. 4-value period_type CHECK plus 4-value status CHECK. Service-layer enforces a strict transition graph UPCOMING then OPEN then GRADING_CLOSED then PUBLISHED — no skipping forward, no walking backward. Multi-column published_chk lockstep pins published_at populated only when status equals PUBLISHED.';

COMMENT ON COLUMN sis_reporting_periods.academic_year_id IS
  'Soft FK to sis_academic_years(id) per ADR-001 and ADR-020.';

CREATE TABLE IF NOT EXISTS sis_student_awards (
  id                       UUID PRIMARY KEY,
  student_id               UUID NOT NULL,
  award_type               TEXT NOT NULL,
  award_name               TEXT NOT NULL,
  academic_year            TEXT,
  term                     TEXT,
  awarded_by               UUID,
  awarded_at               DATE NOT NULL DEFAULT CURRENT_DATE,
  certificate_s3_key       TEXT,
  description              TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_student_awards_student_fk FOREIGN KEY (student_id)
    REFERENCES sis_students(id) ON DELETE CASCADE,
  CONSTRAINT sis_student_awards_type_chk CHECK (
    award_type IN ('HONOR_ROLL','DEANS_LIST','PERFECT_ATTENDANCE','SUBJECT_AWARD','CITIZENSHIP','OTHER')
  )
);

CREATE INDEX IF NOT EXISTS sis_student_awards_student_idx
  ON sis_student_awards(student_id, academic_year);

CREATE INDEX IF NOT EXISTS sis_student_awards_type_idx
  ON sis_student_awards(student_id, award_type);

COMMENT ON TABLE sis_student_awards IS
  'Student award record. 6-value award_type CHECK. Bulk-honor-roll endpoint inserts one row per qualifying student in a single tx after reading the GPA snapshots for the school plus academic year plus configured GPA threshold.';

COMMENT ON COLUMN sis_student_awards.awarded_by IS
  'Soft FK to platform.iam_person(id) per ADR-001 and ADR-020. Identifies the staff member who issued the award. NULL for bulk auto-generated awards.';

CREATE TABLE IF NOT EXISTS sis_medical_exemption_records (
  id                       UUID PRIMARY KEY,
  student_id               UUID NOT NULL,
  exemption_type           TEXT NOT NULL,
  reason                   TEXT NOT NULL,
  doctor_note_s3_key       TEXT,
  effective_from           DATE NOT NULL,
  effective_to             DATE,
  approved_by              UUID,
  approved_at              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_med_exemption_student_fk FOREIGN KEY (student_id)
    REFERENCES sis_students(id) ON DELETE CASCADE,
  CONSTRAINT sis_med_exemption_type_chk CHECK (
    exemption_type IN ('PE','SWIMMING','FIELD_TRIP','OTHER')
  ),
  CONSTRAINT sis_med_exemption_dates_chk CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  )
);

CREATE INDEX IF NOT EXISTS sis_med_exemption_student_idx
  ON sis_medical_exemption_records(student_id, effective_from DESC);

CREATE INDEX IF NOT EXISTS sis_med_exemption_open_ended_idx
  ON sis_medical_exemption_records(student_id, exemption_type)
  WHERE effective_to IS NULL;

CREATE INDEX IF NOT EXISTS sis_med_exemption_effective_to_idx
  ON sis_medical_exemption_records(student_id, exemption_type, effective_to);

COMMENT ON TABLE sis_medical_exemption_records IS
  'Per-student medical exemption from PE plus swimming plus field trips plus other activities. 4-value exemption_type CHECK. doctor_note_s3_key links to the signed doctor note. Multi-column dates_chk enforces effective_to greater than or equal to effective_from when both are set. Open-ended exemptions (effective_to NULL) hit the open-ended partial INDEX. Time-bounded exemptions hit the (student, type, effective_to) INDEX so the day-of-class teacher lookup binds CURRENT_DATE at query time.';

COMMENT ON COLUMN sis_medical_exemption_records.approved_by IS
  'Soft FK to platform.iam_person(id) per ADR-001 and ADR-020. Identifies the staff member who approved the exemption.';
