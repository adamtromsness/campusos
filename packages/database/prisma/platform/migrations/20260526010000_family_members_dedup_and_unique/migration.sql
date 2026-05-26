-- Deduplicate platform_family_members + add UNIQUE constraint.
--
-- Background. Two failure paths produced duplicate ACTIVE rows in
-- a family, both pointing to the same human:
--
--   1. Adam adds Ashley as a PLACEHOLDER guardian → createMemberAccount
--      promotes the placeholder to ACTIVE with a synthesized
--      `@external.invalid` email + a fresh iam_person row.
--   2. The real Ashley registers separately (real email), accepts
--      Adam's GUARDIAN_INVITE → the accept INSERTs a second ACTIVE
--      row with her real iam_person id.
--
-- /family then renders Ashley twice.
--
-- This migration:
--   (a) Deletes the synthetic family_members row when a real one
--       exists in the same family with the same first + last name.
--       The synthetic is identifiable by the `@external.invalid`
--       suffix on platform_users.email. The synthetic iam_person /
--       platform_users rows are left in place — they're harmless
--       orphans and may be referenced by platform_personas cache
--       or other backstop tables that future cleanup can prune.
--
--   (b) Adds a partial UNIQUE INDEX on (family_id, person_id) so
--       any future accept / create path that tries to insert a
--       second person-bound row in the same family fails fast at
--       the DB level. Rows with person_id NULL (PLACEHOLDER /
--       PENDING_INVITE) are excluded — multiple unfilled placeholders
--       with the same name are intentional.

DELETE FROM platform.platform_family_members AS fm_loser
USING platform.platform_family_members AS fm_keep,
      platform.iam_person AS p_loser,
      platform.iam_person AS p_keep,
      platform.platform_users AS u_loser,
      platform.platform_users AS u_keep
WHERE fm_loser.family_id = fm_keep.family_id
  AND fm_loser.id <> fm_keep.id
  AND fm_loser.status = 'ACTIVE'
  AND fm_keep.status = 'ACTIVE'
  AND fm_loser.person_id IS NOT NULL
  AND fm_keep.person_id IS NOT NULL
  AND p_loser.id = fm_loser.person_id
  AND p_keep.id = fm_keep.person_id
  AND u_loser.person_id = p_loser.id
  AND u_keep.person_id = p_keep.id
  AND LOWER(p_loser.first_name) = LOWER(p_keep.first_name)
  AND LOWER(p_loser.last_name) = LOWER(p_keep.last_name)
  AND u_loser.email LIKE '%@external.invalid'
  AND u_keep.email NOT LIKE '%@external.invalid';

CREATE UNIQUE INDEX IF NOT EXISTS platform_family_members_family_person_idx
  ON platform.platform_family_members(family_id, person_id)
  WHERE person_id IS NOT NULL;
