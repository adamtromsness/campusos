/*
 * 059_ext_field_trips.sql — Cycle 17 Step 2.
 *
 * M64 Clubs and Student Life domain 2: field trip planning with
 * digital parent consent collection and chaperone assignments.
 *
 * The PARENT CONSENT KEYSTONE lives on ext_field_trip_consent_records.
 * UNIQUE(field_trip_id, student_id, guardian_person_id) prevents
 * duplicate signatures from the same guardian for the same (trip,
 * student) pair. The Step 6 ConsentService stamps signed_at,
 * ip_address, and guardian_person_id from the request actor and emits
 * ext.consent.received after the tx commits.
 */

CREATE TABLE IF NOT EXISTS ext_field_trips (
  id                    UUID PRIMARY KEY,
  school_id             UUID NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT,
  destination           TEXT NOT NULL,
  trip_date             DATE NOT NULL,
  departure_time        TIME,
  return_time           TIME,
  grade_levels          TEXT[],
  max_participants      INT,
  cost_per_student      NUMERIC(6,2),
  transport_request_id  UUID,
  organiser_id          UUID NOT NULL,
  status                TEXT NOT NULL DEFAULT 'PLANNING',
  consent_deadline      DATE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ext_field_trips_status_chk CHECK (
    status IN ('PLANNING', 'APPROVED', 'CONFIRMED', 'COMPLETED', 'CANCELLED')
  ),
  CONSTRAINT ext_field_trips_max_chk CHECK (max_participants IS NULL OR max_participants > 0),
  CONSTRAINT ext_field_trips_cost_chk CHECK (cost_per_student IS NULL OR cost_per_student >= 0),
  CONSTRAINT ext_field_trips_time_chk CHECK (
    departure_time IS NULL OR return_time IS NULL OR departure_time <= return_time
  ),
  CONSTRAINT ext_field_trips_organiser_fk FOREIGN KEY (organiser_id)
    REFERENCES hr_employees(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS ext_field_trips_school_date_idx
  ON ext_field_trips (school_id, trip_date DESC);

COMMENT ON TABLE ext_field_trips IS
  'Field trip planning. organiser_id NO ACTION preserves audit when staff leaves. transport_request_id is a soft FK to trn_ for future M61 Transportation. status flows PLANNING -> APPROVED -> CONFIRMED -> COMPLETED with CANCELLED as a terminal escape.';

CREATE TABLE IF NOT EXISTS ext_field_trip_participants (
  id                  UUID PRIMARY KEY,
  field_trip_id       UUID NOT NULL,
  student_id          UUID NOT NULL,
  attendance_status   TEXT NOT NULL DEFAULT 'REGISTERED',
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ext_field_trip_participants_status_chk CHECK (
    attendance_status IN ('REGISTERED', 'ATTENDED', 'ABSENT', 'WITHDRAWN')
  ),
  CONSTRAINT ext_field_trip_participants_trip_fk FOREIGN KEY (field_trip_id)
    REFERENCES ext_field_trips(id) ON DELETE CASCADE,
  CONSTRAINT ext_field_trip_participants_student_fk FOREIGN KEY (student_id)
    REFERENCES sis_students(id) ON DELETE CASCADE,
  CONSTRAINT ext_field_trip_participants_uq UNIQUE (field_trip_id, student_id)
);

COMMENT ON TABLE ext_field_trip_participants IS
  'Per-student registration on a field trip. CASCADE on both parents because a participant has no meaning without its trip and is personal student data.';

CREATE TABLE IF NOT EXISTS ext_field_trip_consent_records (
  id                            UUID PRIMARY KEY,
  field_trip_id                 UUID NOT NULL,
  student_id                    UUID NOT NULL,
  guardian_person_id            UUID NOT NULL,
  consent_given                 BOOLEAN NOT NULL,
  signed_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address                    TEXT,
  emergency_contact_override    TEXT,
  medical_notes_override        TEXT,
  notes                         TEXT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ext_field_trip_consent_trip_fk FOREIGN KEY (field_trip_id)
    REFERENCES ext_field_trips(id) ON DELETE CASCADE,
  CONSTRAINT ext_field_trip_consent_student_fk FOREIGN KEY (student_id)
    REFERENCES sis_students(id) ON DELETE CASCADE,
  CONSTRAINT ext_field_trip_consent_uq UNIQUE (field_trip_id, student_id, guardian_person_id)
);

COMMENT ON TABLE ext_field_trip_consent_records IS
  'PARENT CONSENT KEYSTONE. UNIQUE on the trip-student-guardian triple prevents duplicate signatures. guardian_person_id is a soft FK to platform.iam_person per ADR-001 / ADR-020. Step 6 ConsentService emits ext.consent.received after commit.';

CREATE TABLE IF NOT EXISTS ext_field_trip_chaperones (
  id                          UUID PRIMARY KEY,
  field_trip_id               UUID NOT NULL,
  person_id                   UUID NOT NULL,
  role                        TEXT NOT NULL DEFAULT 'CHAPERONE',
  background_check_status     TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
  confirmed                   BOOLEAN NOT NULL DEFAULT false,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ext_field_trip_chaperones_role_chk CHECK (role IN ('LEAD', 'CHAPERONE', 'DRIVER')),
  CONSTRAINT ext_field_trip_chaperones_bg_chk CHECK (
    background_check_status IN ('NOT_REQUIRED', 'PENDING', 'CLEARED', 'FAILED')
  ),
  CONSTRAINT ext_field_trip_chaperones_trip_fk FOREIGN KEY (field_trip_id)
    REFERENCES ext_field_trips(id) ON DELETE CASCADE,
  CONSTRAINT ext_field_trip_chaperones_uq UNIQUE (field_trip_id, person_id)
);

COMMENT ON TABLE ext_field_trip_chaperones IS
  'Chaperone assignments. person_id is a soft FK to platform.iam_person so the column can carry both staff person ids and parent volunteer ids without a polymorphic FK. CASCADE on trip since a chaperone has no meaning without its trip.';
