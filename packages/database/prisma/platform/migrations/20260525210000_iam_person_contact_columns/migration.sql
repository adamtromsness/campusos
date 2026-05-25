-- Adult-profile contact columns on iam_person.
--
-- Adds three groups of fields used by the /profile Contact tab:
--
--   1. Address inheritance toggle + per-person custom address.
--      address_source = 'FAMILY' (the default) inherits the
--      household home address from platform_families; 'CUSTOM' uses
--      the custom_address_* columns below. This mirrors the medical
--      source toggle on platform_child_medical_info — same pattern,
--      different scope.
--
--   2. Work contact (work_email, employer, job_title). work_phone
--      already exists on iam_person from the profile-and-household
--      mini-cycle. employer/occupation existed only on the per-tenant
--      sis_guardian_employment table; this surface puts them on the
--      platform-wide identity row so a guardian's "where they work"
--      shows up on /profile regardless of which tenant they're in.
--
-- All additive + nullable except address_source which has a default,
-- so no backfill is required. The CHECK matches the wire enum on
-- UpdateMyProfileDto.addressSource.

ALTER TABLE platform.iam_person
  ADD COLUMN IF NOT EXISTS address_source TEXT NOT NULL DEFAULT 'FAMILY',
  ADD COLUMN IF NOT EXISTS custom_address_line1 TEXT,
  ADD COLUMN IF NOT EXISTS custom_address_line2 TEXT,
  ADD COLUMN IF NOT EXISTS custom_city TEXT,
  ADD COLUMN IF NOT EXISTS custom_state TEXT,
  ADD COLUMN IF NOT EXISTS custom_postal_code TEXT,
  ADD COLUMN IF NOT EXISTS custom_country TEXT,
  ADD COLUMN IF NOT EXISTS work_email TEXT,
  ADD COLUMN IF NOT EXISTS employer TEXT,
  ADD COLUMN IF NOT EXISTS job_title TEXT;

ALTER TABLE platform.iam_person
  DROP CONSTRAINT IF EXISTS iam_person_address_source_check;

ALTER TABLE platform.iam_person
  ADD CONSTRAINT iam_person_address_source_check
  CHECK (address_source IN ('FAMILY', 'CUSTOM'));
