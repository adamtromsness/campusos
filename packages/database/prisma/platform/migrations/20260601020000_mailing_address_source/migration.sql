-- Mailing address "Use family / Use custom" toggle (FIX 2).
--
-- Adds a per-record mailing_address_source mirroring the existing
-- address_source (home). Combined with the existing same-as-physical
-- boolean it encodes three states:
--   FAMILY                          → inherit the family mailing address
--   CUSTOM + same-as-physical=true  → mailing mirrors this record's physical
--   CUSTOM + same-as-physical=false → custom mailing fields
--
-- Default 'FAMILY' (consistent with home address defaulting to the family
-- address). Existing rows default to FAMILY too; that's the safe inherit
-- default and the read path falls back to the family home address when the
-- family has no separate mailing.
ALTER TABLE platform.platform_family_children
  ADD COLUMN IF NOT EXISTS mailing_address_source TEXT NOT NULL DEFAULT 'FAMILY';

ALTER TABLE platform.iam_person
  ADD COLUMN IF NOT EXISTS mailing_address_source TEXT NOT NULL DEFAULT 'FAMILY';
