-- Per-child home + mailing address on platform_family_children.
--
-- Mirrors the iam_person address shape that the adult /profile
-- Contact tab uses:
--   address_source = 'FAMILY' inherit from platform_families;
--                    'CUSTOM' use the custom_* columns below.
--   mailing_address_different = false (default) means the mailing
--                    address equals the home address (whether home
--                    is FAMILY-inherited or CUSTOM); true means the
--                    mailing_* columns are authoritative.
--
-- The toggles default to "inherit" so existing rows continue to
-- read the family-level address with no migration data work
-- needed. The toggle flips at the child level when a parent
-- overrides for a specific kid (e.g. a child living at a
-- different address part of the week).
--
-- All additive + nullable. The CHECK on address_source uses the
-- standard DROP/ADD pattern so future enum extensions stay easy.

ALTER TABLE platform.platform_family_children
  ADD COLUMN IF NOT EXISTS address_source         TEXT    NOT NULL DEFAULT 'FAMILY',
  ADD COLUMN IF NOT EXISTS custom_address_line1   TEXT,
  ADD COLUMN IF NOT EXISTS custom_address_line2   TEXT,
  ADD COLUMN IF NOT EXISTS custom_city            TEXT,
  ADD COLUMN IF NOT EXISTS custom_state           TEXT,
  ADD COLUMN IF NOT EXISTS custom_postal_code     TEXT,
  ADD COLUMN IF NOT EXISTS custom_country         TEXT,
  ADD COLUMN IF NOT EXISTS mailing_address_different BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mailing_line1          TEXT,
  ADD COLUMN IF NOT EXISTS mailing_line2          TEXT,
  ADD COLUMN IF NOT EXISTS mailing_city           TEXT,
  ADD COLUMN IF NOT EXISTS mailing_state          TEXT,
  ADD COLUMN IF NOT EXISTS mailing_postal_code    TEXT,
  ADD COLUMN IF NOT EXISTS mailing_country        TEXT;

ALTER TABLE platform.platform_family_children
  DROP CONSTRAINT IF EXISTS platform_family_children_address_source_check;

ALTER TABLE platform.platform_family_children
  ADD CONSTRAINT platform_family_children_address_source_check
  CHECK (address_source IN ('FAMILY', 'CUSTOM'));
