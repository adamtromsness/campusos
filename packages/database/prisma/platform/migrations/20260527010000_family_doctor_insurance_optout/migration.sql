-- Opt-out toggles for family doctor + insurance on platform_families.
--
-- Three-state booleans:
--   NULL  → "not answered" — the legacy default. Treated as
--           ❌ incomplete by the family-settings completion checker
--           when the corresponding fields are also blank.
--   true  → "we have one" — same effect as filling out the fields
--           (the user is acknowledging it exists, even if they
--           haven't filled the details in yet — useful for staging
--           data they don't have to hand).
--   false → "we don't have one" — an explicit opt-out. The
--           completion checker treats this as ✅ complete so a
--           family without a doctor / insurance can still reach
--           100% without having to dump fake values into the fields.
--
-- Migration is additive: existing rows stay NULL, so completion-
-- check semantics for already-populated families don't change.

ALTER TABLE platform.platform_families
  ADD COLUMN IF NOT EXISTS has_family_doctor BOOLEAN;

ALTER TABLE platform.platform_families
  ADD COLUMN IF NOT EXISTS has_insurance BOOLEAN;
