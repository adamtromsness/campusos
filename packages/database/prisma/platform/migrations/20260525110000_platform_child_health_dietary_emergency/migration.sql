-- Platform-level medical / emergency-contact / dietary data for
-- children who don't have a tenant enrolment yet.
--
-- Today these record classes live in the tenant schemas:
--   hlth_health_records + hlth_allergies + hlth_medications      (m23-health)
--   sis_emergency_contacts                                       (m20-sis)
--   fds_dietary_restrictions                                     (m63-food-service)
--
-- All of those require a sis_students row, which doesn't exist
-- until the child is enrolled. For pre-enrolment families (the
-- common state of a freshly-LINKED child on /family/children/:id)
-- the parent has nowhere to record peanut allergies or grandma's
-- pickup number. These three platform tables hold that data until
-- enrolment, at which point the data syncs into the tenant tables.
--
-- TODO: enrolment-time sync. When sis_students is created for the
-- linked person, a worker reads platform_child_medical_info +
-- platform_child_emergency_contacts + platform_child_dietary_info
-- and seeds the tenant tables. Sources of truth flip from platform
-- → tenant at that point.
--
-- Additive + idempotent. CREATE TABLE IF NOT EXISTS so re-runs are
-- no-ops.

-- ─── Medical info — one row per child ──────────────────────
CREATE TABLE IF NOT EXISTS platform.platform_child_medical_info (
  id                  UUID PRIMARY KEY,
  person_id           UUID NOT NULL UNIQUE REFERENCES platform.iam_person(id),
  family_id           UUID NOT NULL REFERENCES platform.platform_families(id),
  -- JSONB list of { name, severity ('MILD'|'MODERATE'|'SEVERE'|'LIFE_THREATENING'),
  -- type ('FOOD'|'ENVIRONMENTAL'|'MEDICATION'|'OTHER'), notes }.
  allergies           JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- JSONB list of { name, dosage, frequency, prescriber, notes }.
  medications         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- JSONB list of { name, diagnosedDate, notes }.
  conditions          JSONB NOT NULL DEFAULT '[]'::jsonb,
  doctor_name         TEXT,
  doctor_phone        TEXT,
  doctor_clinic       TEXT,
  insurance_provider  TEXT,
  insurance_policy    TEXT,
  insurance_group     TEXT,
  blood_type          TEXT,
  medical_notes       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS "platform_child_medical_info_family_id_idx"
  ON platform.platform_child_medical_info (family_id);

-- ─── Emergency contacts — many per child ───────────────────
CREATE TABLE IF NOT EXISTS platform.platform_child_emergency_contacts (
  id                 UUID PRIMARY KEY,
  person_id          UUID NOT NULL REFERENCES platform.iam_person(id),
  family_id          UUID NOT NULL REFERENCES platform.platform_families(id),
  name               TEXT NOT NULL,
  relationship       TEXT NOT NULL,
  phone_primary      TEXT NOT NULL,
  phone_alternate    TEXT,
  email              TEXT,
  authorized_pickup  BOOLEAN NOT NULL DEFAULT false,
  priority_order     INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS "platform_child_emergency_contacts_person_phone_uq"
  ON platform.platform_child_emergency_contacts (person_id, phone_primary);

CREATE INDEX IF NOT EXISTS "platform_child_emergency_contacts_person_priority_idx"
  ON platform.platform_child_emergency_contacts (person_id, priority_order);

CREATE INDEX IF NOT EXISTS "platform_child_emergency_contacts_family_id_idx"
  ON platform.platform_child_emergency_contacts (family_id);

-- ─── Dietary info — one row per child ──────────────────────
CREATE TABLE IF NOT EXISTS platform.platform_child_dietary_info (
  id                        UUID PRIMARY KEY,
  person_id                 UUID NOT NULL UNIQUE REFERENCES platform.iam_person(id),
  family_id                 UUID NOT NULL REFERENCES platform.platform_families(id),
  dietary_type              TEXT NOT NULL DEFAULT 'NONE',
  -- JSONB list of { name, severity, notes } — kept separate from
  -- the medical-section allergies list because the UI cross-refs
  -- the two later, but they're stored independently.
  food_allergies            JSONB NOT NULL DEFAULT '[]'::jsonb,
  additional_restrictions   TEXT,
  meal_preference           TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ,
  CONSTRAINT platform_child_dietary_info_type_check
    CHECK (dietary_type IN (
      'NONE', 'VEGETARIAN', 'VEGAN', 'HALAL', 'KOSHER',
      'GLUTEN_FREE', 'DAIRY_FREE', 'OTHER'
    ))
);

CREATE INDEX IF NOT EXISTS "platform_child_dietary_info_family_id_idx"
  ON platform.platform_child_dietary_info (family_id);
