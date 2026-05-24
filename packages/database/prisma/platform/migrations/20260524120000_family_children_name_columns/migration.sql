-- Add middle_name + preferred_name to platform_family_children so
-- PLACEHOLDER children can carry the same identity fields a LINKED
-- child gets from iam_person. The Add-a-child wizard captures these
-- up-front; before this migration they had nowhere to live until the
-- child was promoted to LINKED and an iam_person row existed.
--
-- For LINKED rows iam_person remains the canonical source — the
-- selectSql COALESCEs iam_person first, falls back to the mirror —
-- so existing reads stay consistent. The update() service writes
-- both tables in one tx, mirroring the first_name / last_name /
-- date_of_birth pattern that's already in place.
--
-- Additive + idempotent. Safe to re-run.

ALTER TABLE platform.platform_family_children
  ADD COLUMN IF NOT EXISTS middle_name TEXT,
  ADD COLUMN IF NOT EXISTS preferred_name TEXT;
