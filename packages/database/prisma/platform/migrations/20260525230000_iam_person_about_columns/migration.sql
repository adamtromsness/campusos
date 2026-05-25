-- About-tab columns on iam_person.
--
-- Adults (parents/guardians/staff) get a free-form bio, an
-- interests/skills tag list, and a languages-spoken tag list on
-- /profile → About. Useful for volunteer matching, coaching/guest
-- speaker recruitment, and parent-communication translation needs.
--
-- JSONB arrays of strings — simplest schema for a tag list, and the
-- existing platform_child_medical_info pattern uses JSONB for
-- allergies/medications/conditions so this is consistent.
--
-- All additive + nullable / default-empty, no backfill required.

ALTER TABLE platform.iam_person
  ADD COLUMN IF NOT EXISTS bio TEXT,
  ADD COLUMN IF NOT EXISTS interests JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS languages JSONB NOT NULL DEFAULT '[]';
