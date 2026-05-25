-- Emergency-pickup preference on family-guardian rows.
--
-- The /family/settings → Emergency Contacts tab auto-populates with
-- every guardian (platform_family_members with member_role in the
-- guardian set). Each guardian row needs an "authorized for pickup"
-- toggle. The flag is a family-level preference about the guardian,
-- not an iam_person attribute (a guardian can be pickup-authorized
-- in one family and not in another), so it lives here.
--
-- Default true — guardians are typically pickup-authorized; the
-- toggle is an explicit opt-out for unusual situations.

ALTER TABLE platform.platform_family_members
  ADD COLUMN IF NOT EXISTS emergency_authorized_pickup BOOLEAN NOT NULL DEFAULT true;
