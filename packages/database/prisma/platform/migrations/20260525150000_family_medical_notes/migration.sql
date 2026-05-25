-- Family-wide medical notes — surfaced on the Health & Insurance tab
-- of /family/settings and shared with schools as part of the
-- family-inherited medical view.
--
-- Distinct from platform_child_medical_info.medical_notes which is
-- per-child; this is the family-default that children inherit when
-- their medical_source is 'FAMILY'.
--
-- Additive, nullable — no backfill needed.

ALTER TABLE platform.platform_families
  ADD COLUMN IF NOT EXISTS medical_notes TEXT;
