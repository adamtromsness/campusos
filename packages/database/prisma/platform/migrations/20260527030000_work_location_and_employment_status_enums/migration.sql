-- Occupation tab: work_location_type + employment_status enum swap.
--
-- Two changes:
--
-- 1. New work_location_type column (TEXT + CHECK on OFFICE / REMOTE /
--    HYBRID). Drives the new three-way work-location radio: REMOTE
--    hides the work-address fields, OFFICE/HYBRID show them (HYBRID
--    adds a helper "enter your primary office location" note in the
--    UI). NULL = not answered, the legacy default.
--
-- 2. Swap HOMEMAKER → STAY_AT_HOME_PARENT in the employment_status
--    enum. "Homemaker" reads dated; STAY_AT_HOME_PARENT is more
--    inclusive (covers caregivers regardless of marital status or
--    employment history). Any existing rows with the old value are
--    remapped in-place before the new CHECK constraint is applied,
--    so the new CHECK doesn't reject pre-migration data.
--
-- All additive on the column side; the CHECK swap follows the
-- DROP-IF-EXISTS → ADD pattern from the original occupation
-- migration (20260525240000) which CLAUDE.md sanctions for enum
-- evolution under TEXT + CHECK.

ALTER TABLE platform.iam_person
  ADD COLUMN IF NOT EXISTS work_location_type TEXT;

ALTER TABLE platform.iam_person
  DROP CONSTRAINT IF EXISTS iam_person_work_location_type_check;

ALTER TABLE platform.iam_person
  ADD CONSTRAINT iam_person_work_location_type_check
  CHECK (
    work_location_type IS NULL
    OR work_location_type IN ('OFFICE', 'REMOTE', 'HYBRID')
  );

-- Remap legacy HOMEMAKER values BEFORE swapping the CHECK so the new
-- constraint doesn't reject them. Idempotent — re-running this UPDATE
-- on a dataset that already has STAY_AT_HOME_PARENT rows is a no-op
-- because the WHERE only matches the old value.
UPDATE platform.iam_person
   SET employment_status = 'STAY_AT_HOME_PARENT'
 WHERE employment_status = 'HOMEMAKER';

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
      'STAY_AT_HOME_PARENT',
      'NOT_SPECIFIED'
    )
  );
