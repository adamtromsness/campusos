-- Occupation-tab columns on iam_person.
--
-- The /profile page gets a new Occupation tab. employer / job_title /
-- work_phone / work_email already exist on iam_person from the
-- earlier Contact-tab migration; this migration adds:
--   - employment_status — one of EMPLOYED_FULL_TIME / EMPLOYED_PART_TIME /
--     SELF_EMPLOYED / UNEMPLOYED / RETIRED / STUDENT / HOMEMAKER /
--     NOT_SPECIFIED (TEXT + CHECK; easier to extend than PG ENUM
--     per CLAUDE.md).
--   - industry — free-text picker on the wire; the UI exposes a fixed
--     dropdown but the column is open so unusual industries don't
--     need a schema change.
--   - work_address_* — 6 columns mirroring the home-address shape on
--     platform_families. Optional; the UI gates rendering behind a
--     toggle.
--
-- All additive + nullable, no backfill.

ALTER TABLE platform.iam_person
  ADD COLUMN IF NOT EXISTS employment_status TEXT,
  ADD COLUMN IF NOT EXISTS industry TEXT,
  ADD COLUMN IF NOT EXISTS work_address_line1 TEXT,
  ADD COLUMN IF NOT EXISTS work_address_line2 TEXT,
  ADD COLUMN IF NOT EXISTS work_city TEXT,
  ADD COLUMN IF NOT EXISTS work_state TEXT,
  ADD COLUMN IF NOT EXISTS work_postal_code TEXT,
  ADD COLUMN IF NOT EXISTS work_country TEXT;

ALTER TABLE platform.iam_person
  DROP CONSTRAINT IF EXISTS iam_person_employment_status_check;

ALTER TABLE platform.iam_person
  ADD CONSTRAINT iam_person_employment_status_check
  CHECK (
    employment_status IS NULL
    OR employment_status IN (
      'EMPLOYED_FULL_TIME',
      'EMPLOYED_PART_TIME',
      'SELF_EMPLOYED',
      'UNEMPLOYED',
      'RETIRED',
      'STUDENT',
      'HOMEMAKER',
      'NOT_SPECIFIED'
    )
  );
