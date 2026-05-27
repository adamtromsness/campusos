-- Multi-email support for iam_person.
--
-- Mirrors platform_person_phones. One iam_person row → many
-- platform_person_emails rows. Each row carries an email, a type
-- (Personal/Work/School/Other), a verified flag (future: email
-- verification flow), and an isPrimary flag (exactly one per person,
-- enforced by partial UNIQUE index).
--
-- iam_person itself has no `email` column today — the login email
-- lives on platform_users (the auth row) and the contact email used
-- to be split across iam_person.personal_email / .work_email. This
-- table replaces both contact slots with a multi-row list and
-- becomes the canonical source for "where do we email this person?"
-- The platform_users.email column — the login / IdP identifier — is
-- left untouched: changing the primary contact email does NOT change
-- the login email. That requires a separate email-verification flow
-- (future work).
--
-- Backfill seeds one row per iam_person that has a platform_users
-- (auth) row — the registration email is taken as the initial
-- PERSONAL, is_primary, verified contact email. iam_person rows
-- without a platform_users row (synthetic placeholders created by
-- e.g. createMemberAccount before the human accepts the invite) are
-- skipped; the lazy-seed path in the service handles them on first
-- GET /profile/me/emails once the person actually authenticates.

CREATE TABLE IF NOT EXISTS platform.platform_person_emails (
  id          UUID PRIMARY KEY,
  person_id   UUID NOT NULL REFERENCES platform.iam_person(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'PERSONAL',
  is_primary  BOOLEAN NOT NULL DEFAULT false,
  verified    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ
);

ALTER TABLE platform.platform_person_emails
  DROP CONSTRAINT IF EXISTS platform_person_emails_type_check;

ALTER TABLE platform.platform_person_emails
  ADD CONSTRAINT platform_person_emails_type_check
  CHECK (type IN ('PERSONAL', 'WORK', 'SCHOOL', 'OTHER'));

-- Partial UNIQUE: at most one primary per person. Postgres treats
-- "is_primary = true" as the partial predicate so a person can have
-- many is_primary=false rows but only one is_primary=true.
CREATE UNIQUE INDEX IF NOT EXISTS platform_person_emails_one_primary_idx
  ON platform.platform_person_emails(person_id)
  WHERE is_primary = true;

-- A person can't list the same email twice. Case-insensitive — emails
-- are de-facto case-insensitive (every modern MTA treats the local-
-- part as insensitive) and treating them otherwise would let a user
-- duplicate-add Foo@x.com / foo@x.com which doesn't help anyone.
CREATE UNIQUE INDEX IF NOT EXISTS platform_person_emails_person_email_idx
  ON platform.platform_person_emails(person_id, LOWER(email));

CREATE INDEX IF NOT EXISTS platform_person_emails_person_idx
  ON platform.platform_person_emails(person_id, is_primary DESC, created_at);

-- Backfill: one PERSONAL row per existing iam_person that has a
-- platform_users (auth) row carrying an email. Excludes synthetic
-- @external.invalid addresses created by createMemberAccount for
-- placeholder guardians — those aren't real and shouldn't seed a
-- contact email. Idempotent — re-running the migration is a no-op
-- via the NOT EXISTS guard.
INSERT INTO platform.platform_person_emails (id, person_id, email, type, is_primary, verified)
SELECT
  gen_random_uuid(),
  ip.id,
  pu.email,
  'PERSONAL',
  true,
  true
FROM platform.iam_person ip
JOIN platform.platform_users pu ON pu.person_id = ip.id
WHERE pu.email IS NOT NULL
  AND pu.email <> ''
  AND pu.email NOT LIKE '%@external.invalid'
  AND NOT EXISTS (
    SELECT 1 FROM platform.platform_person_emails pe
    WHERE pe.person_id = ip.id
  );
