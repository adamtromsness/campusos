-- Per-child inheritance toggle for the medical record.
--
-- When medical_source = 'FAMILY' (the default for new rows), the
-- child's doctor + insurance fields on the wire are inherited from
-- platform_families.{doctor_*, insurance_*}; the per-child
-- doctor_* / insurance_* columns are ignored on read.
--
-- When medical_source = 'CUSTOM', the per-child columns are
-- authoritative. The allergies/medications/conditions/bloodType
-- arrays + medicalNotes are ALWAYS per-child — they don't inherit
-- regardless of medical_source.
--
-- Default 'FAMILY' is chosen because most pre-enrolment families
-- share a doctor + insurance; CUSTOM is opted into only when
-- something differs.

ALTER TABLE platform.platform_child_medical_info
  ADD COLUMN IF NOT EXISTS medical_source TEXT NOT NULL DEFAULT 'FAMILY';

ALTER TABLE platform.platform_child_medical_info
  DROP CONSTRAINT IF EXISTS platform_child_medical_info_medical_source_check;

ALTER TABLE platform.platform_child_medical_info
  ADD CONSTRAINT platform_child_medical_info_medical_source_check
  CHECK (medical_source IN ('FAMILY', 'CUSTOM'));
