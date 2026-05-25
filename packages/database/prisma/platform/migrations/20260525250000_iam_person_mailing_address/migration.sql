-- Per-person mailing address on iam_person.
--
-- The /profile Contact tab gets a mailing-address subsection with
-- a "same as home address" / "different mailing address" toggle.
-- Most people use the home address; the toggle is opt-in for the
-- minority who get mail at a PO Box, work, or a separate address.
--
-- DB column is `mailing_same_as_home` (positive sense, default true)
-- so an unmigrated row reads as "same" — matching the existing
-- behavior. The wire format mirrors platform_families:
-- `mailingAddressDifferent` is the inverse, because UI copy reads
-- more naturally as "Mailing address is different from home address".
--
-- All additive + nullable, no backfill.

ALTER TABLE platform.iam_person
  ADD COLUMN IF NOT EXISTS mailing_same_as_home BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS custom_mailing_line1 TEXT,
  ADD COLUMN IF NOT EXISTS custom_mailing_line2 TEXT,
  ADD COLUMN IF NOT EXISTS custom_mailing_city TEXT,
  ADD COLUMN IF NOT EXISTS custom_mailing_state TEXT,
  ADD COLUMN IF NOT EXISTS custom_mailing_postal_code TEXT,
  ADD COLUMN IF NOT EXISTS custom_mailing_country TEXT;
