-- Family-level shared attributes: doctor + insurance + display name override.
--
-- platform_families already carries the family-level address + mailing
-- address + home phone + notes (FamilyMemberSyncWorker projects from
-- sis_family_members). The pre-enrolment registration flow needs the
-- same shared shape for the family doctor and the family insurance
-- so a household with multiple children only enters those details
-- once, and so the per-child medical profile can inherit from the
-- family record by default.
--
-- All new columns are NULL-able and additive only — no production
-- backfill needed; existing FamilyMemberSyncWorker emits keep working
-- unchanged because they don't touch these columns.

ALTER TABLE platform.platform_families
  ADD COLUMN IF NOT EXISTS doctor_name TEXT,
  ADD COLUMN IF NOT EXISTS doctor_phone TEXT,
  ADD COLUMN IF NOT EXISTS doctor_clinic TEXT,
  ADD COLUMN IF NOT EXISTS insurance_provider TEXT,
  ADD COLUMN IF NOT EXISTS insurance_policy TEXT,
  ADD COLUMN IF NOT EXISTS insurance_group TEXT;
