-- One-time backfill: sync LINKED child gender from the family mirror
-- into the canonical iam_person identity row.
--
-- Background. A parent editing a LINKED child's profile writes gender
-- to platform_family_children (the family-view mirror) but, until the
-- accompanying FamilyChildrenService.update fix, NOT to iam_person.
-- The child's own /profile page reads gender from iam_person, so the
-- two diverged: the parent saw e.g. "Female" while the child saw
-- "Not Specified".
--
-- Going forward the service mirrors gender to BOTH tables. This
-- statement repairs rows that were edited before the fix shipped:
-- any LINKED child whose family-mirror gender is set but whose
-- iam_person.gender is NULL or stale. The family mirror wins because
-- it holds the value the parent most recently entered.
--
-- Idempotent — re-running matches no rows once iam_person agrees.

UPDATE platform.iam_person p
   SET gender = fc.gender
  FROM platform.platform_family_children fc
 WHERE fc.person_id = p.id
   AND fc.status = 'LINKED'
   AND fc.gender IS NOT NULL
   AND (p.gender IS NULL OR p.gender <> fc.gender);
