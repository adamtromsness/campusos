-- linked_person_id on platform_family_emergency_contacts.
--
-- NULL → manual entry; the row's own name/phone/email columns are
-- authoritative.
--
-- NOT NULL → the contact IS a CampusOS user. name/phone/email are
-- mirrored on the row at link-time and refreshed on read; the
-- iam_person record is the source of truth so a guardian who
-- updates their own profile pushes the new info through to every
-- family that's linked to them.
--
-- Hard FK with ON DELETE SET NULL — if the linked person is ever
-- deleted, the contact row survives as a manual entry rather than
-- disappearing silently.

ALTER TABLE platform.platform_family_emergency_contacts
  ADD COLUMN IF NOT EXISTS linked_person_id UUID
    REFERENCES platform.iam_person(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS platform_family_emergency_contacts_linked_person_idx
  ON platform.platform_family_emergency_contacts(linked_person_id)
  WHERE linked_person_id IS NOT NULL;
