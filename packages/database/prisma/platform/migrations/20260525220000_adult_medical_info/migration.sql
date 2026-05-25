-- Adult-side medical info, parallel shape to
-- platform_child_medical_info.
--
-- Adults (parents/guardians/staff) get optional medical info on
-- /profile → Medical & Health. Staff schools need to know for field
-- trip planning + school events; emergency responders may need it
-- for adults too. Same FAMILY/CUSTOM source toggle the child surface
-- uses; same JSONB-array shape for allergies / medications /
-- conditions; same doctor + insurance fields.
--
-- Distinct table (not a rename of platform_child_medical_info) so
-- the child-side schema + service + endpoints stay frozen and the
-- adult path can evolve independently. Future cleanup could
-- generalise to platform_person_medical_info; deferred.

CREATE TABLE IF NOT EXISTS platform.platform_adult_medical_info (
  id              UUID PRIMARY KEY,
  person_id       UUID NOT NULL UNIQUE
                  REFERENCES platform.iam_person(id) ON DELETE CASCADE,
  -- JSONB array of { name, severity, type, notes }
  allergies       JSONB NOT NULL DEFAULT '[]',
  -- JSONB array of { name, dosage, frequency, prescriber, notes }
  medications     JSONB NOT NULL DEFAULT '[]',
  -- JSONB array of { name, diagnosedDate, notes }
  conditions      JSONB NOT NULL DEFAULT '[]',
  medical_source  TEXT NOT NULL DEFAULT 'FAMILY',
  doctor_name     TEXT,
  doctor_phone    TEXT,
  doctor_clinic   TEXT,
  insurance_provider TEXT,
  insurance_policy   TEXT,
  insurance_group    TEXT,
  blood_type      TEXT,
  medical_notes   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ
);

ALTER TABLE platform.platform_adult_medical_info
  DROP CONSTRAINT IF EXISTS platform_adult_medical_info_source_check;

ALTER TABLE platform.platform_adult_medical_info
  ADD CONSTRAINT platform_adult_medical_info_source_check
  CHECK (medical_source IN ('FAMILY', 'CUSTOM'));
