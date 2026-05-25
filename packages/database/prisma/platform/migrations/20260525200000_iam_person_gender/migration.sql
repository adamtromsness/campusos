-- gender on iam_person.
--
-- Adults (parents/guardians/staff) need a self-editable gender on
-- /profile. Today gender lives only on sis_student_demographics
-- (per-tenant, admin-only) — fine for students, useless for an
-- adult guardian who has no sis_students row in any tenant.
--
-- This column is platform-wide and self-editable. The existing
-- sis_student_demographics.gender stays as the admin-managed
-- per-tenant attribute for students; the two can diverge but the
-- top-level /profile/me read prefers this one (canonical identity).
--
-- Nullable + additive — no backfill needed. Picker on the wire
-- accepts 'F' / 'M' / '' (Not Specified), matching the family-child
-- form; older free-form values would still render fine via the
-- existing genderLabel helper.

ALTER TABLE platform.iam_person
  ADD COLUMN IF NOT EXISTS gender TEXT;
