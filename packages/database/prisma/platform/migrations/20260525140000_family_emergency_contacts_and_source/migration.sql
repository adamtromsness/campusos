-- Family-level emergency contacts (shared default) + per-child source toggle.
--
-- Mirrors platform_child_emergency_contacts in shape but keyed on
-- family_id instead of person_id. The per-child rows are still
-- authoritative when emergency_contact_source = 'CUSTOM'; in
-- 'FAMILY' mode the per-child rows are rendered as additive
-- "additional contacts for this child only" on top of the family
-- defaults.
--
-- Hard FK to platform_families with ON DELETE CASCADE — a deleted
-- family takes its emergency contacts with it. (Per-child contacts
-- already cascade through person_id → iam_person.)

CREATE TABLE IF NOT EXISTS platform.platform_family_emergency_contacts (
  id                 UUID PRIMARY KEY,
  family_id          UUID NOT NULL
                     REFERENCES platform.platform_families(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS platform_family_emergency_contacts_family_id_idx
  ON platform.platform_family_emergency_contacts(family_id, priority_order);

-- One contact per (family, primary phone) — same idempotency
-- contract as platform_child_emergency_contacts uses on
-- (person_id, phone_primary). 23505 → 409 in the service.
CREATE UNIQUE INDEX IF NOT EXISTS platform_family_emergency_contacts_phone_idx
  ON platform.platform_family_emergency_contacts(family_id, phone_primary);

-- Per-child source toggle. Lives on platform_family_children because
-- the row exists for every child unconditionally (LINKED or not),
-- so we don't need on-demand creation just to record the preference.
-- medical_source on platform_child_medical_info follows the opposite
-- pattern for medical-data reasons; this one is a pure preference
-- flag, so the per-child row is the natural home.
ALTER TABLE platform.platform_family_children
  ADD COLUMN IF NOT EXISTS emergency_contact_source TEXT NOT NULL DEFAULT 'FAMILY';

ALTER TABLE platform.platform_family_children
  DROP CONSTRAINT IF EXISTS platform_family_children_emergency_contact_source_check;

ALTER TABLE platform.platform_family_children
  ADD CONSTRAINT platform_family_children_emergency_contact_source_check
  CHECK (emergency_contact_source IN ('FAMILY', 'CUSTOM'));
