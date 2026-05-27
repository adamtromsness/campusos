-- Occupation cleanup — drop redundant work_phone / work_email,
-- add occupation_notes.
--
-- Background. work_phone and work_email were added on iam_person in
-- the May-25 Occupation-tab build because that tab needed a place to
-- store work contact info. Subsequently, platform_person_phones
-- (with type='WORK') and platform_person_emails (with type='WORK')
-- arrived as the canonical multi-row contact lists — making the two
-- columns on iam_person duplicate data. The CampusOS data policy
-- forbids two surfaces for the same fact.
--
-- This migration drops both columns. We invoke the CLAUDE.md
-- "pre-deployment edits to fix architectural errors are categorically
-- different" exception to the additive-only rule: Phase 2 is closed,
-- no pilot tenant exists yet, the columns were never read from any
-- production surface, and leaving them on the schema would invite
-- future code to write to the wrong place. Backfill from
-- platform_person_phones / platform_person_emails is NOT performed —
-- existing values were only ever written via the Occupation tab,
-- which is now replaced by the multi-row tables; any user with a
-- WORK contact value has already moved to the new tables.
--
-- occupation_notes is the new free-text "anything else schools
-- should know about your work life" field (shift schedules,
-- availability during school hours, preferred contact times, etc.).
-- 500-char cap is enforced at the application layer.

ALTER TABLE platform.iam_person DROP COLUMN IF EXISTS work_phone;
ALTER TABLE platform.iam_person DROP COLUMN IF EXISTS work_email;

ALTER TABLE platform.iam_person
  ADD COLUMN IF NOT EXISTS occupation_notes TEXT;
