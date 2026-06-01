-- Standardise stored gender to the canonical option set
-- (MALE | FEMALE | NOT_SPECIFIED) so existing data matches the new
-- three-option product set. Legacy single-letter codes map by sex;
-- every other non-null value (historical NONBINARY / OTHER / UNDISCLOSED
-- / free text) collapses to NOT_SPECIFIED. NULL is left as-is — it isn't
-- a legacy value and the read path already normalises NULL to
-- NOT_SPECIFIED for display.
--
-- Two stores carry a self/family gender: iam_person.gender (the
-- canonical identity value used by /profile/me + account creation) and
-- platform_family_children.gender (the family-children mirror). The
-- admin-managed per-tenant sis_student_demographics.gender is a separate
-- concern and intentionally untouched.

UPDATE platform.iam_person
   SET gender = CASE upper(btrim(gender))
                  WHEN 'M' THEN 'MALE'
                  WHEN 'MALE' THEN 'MALE'
                  WHEN 'F' THEN 'FEMALE'
                  WHEN 'FEMALE' THEN 'FEMALE'
                  ELSE 'NOT_SPECIFIED'
                END
 WHERE gender IS NOT NULL
   AND upper(btrim(gender)) NOT IN ('MALE', 'FEMALE', 'NOT_SPECIFIED');

UPDATE platform.platform_family_children
   SET gender = CASE upper(btrim(gender))
                  WHEN 'M' THEN 'MALE'
                  WHEN 'MALE' THEN 'MALE'
                  WHEN 'F' THEN 'FEMALE'
                  WHEN 'FEMALE' THEN 'FEMALE'
                  ELSE 'NOT_SPECIFIED'
                END
 WHERE gender IS NOT NULL
   AND upper(btrim(gender)) NOT IN ('MALE', 'FEMALE', 'NOT_SPECIFIED');
