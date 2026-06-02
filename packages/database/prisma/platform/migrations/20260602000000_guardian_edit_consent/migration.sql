-- Guardian edit-access consent — platform_guardian_edit_consent.
--
-- Backs the age + consent model for who may edit a person's account:
--   - subject UNDER 18: a guardian edits unconditionally (this table is
--     never consulted).
--   - subject 18+: guardian edit access exists only with the adult's
--     consent. The now-adult controls it (revoke / grant).
--
-- State is DIRECTIONAL, per (guardian, subject) pair:
--   GRANTED | REVOKED.
--
-- Carryover (no lockout on deploy): an ABSENT row reads as GRANTED at 18+.
-- That makes every pre-existing guardian link to a current-or-future adult
-- carry over automatically — no data backfill is required to preserve
-- today's access. Rows are materialised only when:
--   - a NEW guardian link forms while the subject is already 18+  → REVOKED
--     (a new guardian does not get silent access to an adult), or
--   - the adult explicitly grants/revokes a guardian               → GRANTED/REVOKED.
--
-- platform-internal FK references to iam_person are allowed (the
-- ADR-001/020 soft-FK prohibition is about TENANT tables referencing
-- platform tables, not platform-internal references).

CREATE TABLE IF NOT EXISTS platform.platform_guardian_edit_consent (
  id                 UUID PRIMARY KEY,
  guardian_person_id UUID NOT NULL REFERENCES platform.iam_person(id),
  subject_person_id  UUID NOT NULL REFERENCES platform.iam_person(id),
  state              TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- state enum (TEXT + CHECK per the P2-H4 ADV-06 ratification).
ALTER TABLE platform.platform_guardian_edit_consent
  DROP CONSTRAINT IF EXISTS platform_guardian_edit_consent_state_check;
ALTER TABLE platform.platform_guardian_edit_consent
  ADD CONSTRAINT platform_guardian_edit_consent_state_check
  CHECK (state IN ('GRANTED', 'REVOKED'));

-- A guardian cannot be their own subject.
ALTER TABLE platform.platform_guardian_edit_consent
  DROP CONSTRAINT IF EXISTS platform_guardian_edit_consent_no_self;
ALTER TABLE platform.platform_guardian_edit_consent
  ADD CONSTRAINT platform_guardian_edit_consent_no_self
  CHECK (guardian_person_id <> subject_person_id);

-- One consent row per (guardian, subject) pair.
CREATE UNIQUE INDEX IF NOT EXISTS platform_guardian_edit_consent_pair_uq
  ON platform.platform_guardian_edit_consent (guardian_person_id, subject_person_id);

-- The subject-driven control lists every guardian by subject.
CREATE INDEX IF NOT EXISTS platform_guardian_edit_consent_subject_idx
  ON platform.platform_guardian_edit_consent (subject_person_id);
