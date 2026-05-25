-- Per-category primary-contact routing for a family.
--
-- Schools reach out to a different guardian depending on the
-- category of communication: billing goes to one parent, health to
-- another, transport to the one who runs morning drop-off. This
-- table records the routing — one row per (family, category).
--
-- The 8 categories below cover what showed up in the spec; new
-- categories ship as additional CHECK values + UI rows. Keeping
-- TEXT + CHECK (rather than PG ENUM) per CLAUDE.md — TEXT enums
-- are easier to extend later.
--
-- Default rows are lazily seeded on first read of GET
-- /family/contact-preferences when the family has a primary
-- contact set; that keeps the migration additive without a
-- backfill query against every existing family row.

CREATE TABLE IF NOT EXISTS platform.platform_family_contact_preferences (
  id                UUID PRIMARY KEY,
  family_id         UUID NOT NULL
                    REFERENCES platform.platform_families(id) ON DELETE CASCADE,
  category          TEXT NOT NULL,
  primary_person_id UUID NOT NULL
                    REFERENCES platform.iam_person(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ
);

ALTER TABLE platform.platform_family_contact_preferences
  DROP CONSTRAINT IF EXISTS platform_family_contact_preferences_category_check;

ALTER TABLE platform.platform_family_contact_preferences
  ADD CONSTRAINT platform_family_contact_preferences_category_check
  CHECK (category IN (
    'GENERAL',
    'ELECTRONIC_APPROVALS',
    'TRANSPORTATION',
    'HEALTH_MEDICAL',
    'BILLING_FINANCIAL',
    'ACADEMIC',
    'BEHAVIOUR_DISCIPLINE',
    'EMERGENCY'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS platform_family_contact_preferences_family_category_idx
  ON platform.platform_family_contact_preferences(family_id, category);

CREATE INDEX IF NOT EXISTS platform_family_contact_preferences_family_idx
  ON platform.platform_family_contact_preferences(family_id);
