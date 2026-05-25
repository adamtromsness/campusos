-- Multi-phone support for iam_person.
--
-- One iam_person row → many platform_person_phones rows. Each row
-- carries a number, a type (Cell/Home/Work/Other), a texts-allowed
-- flag (schools use this for broadcast SMS opt-in), and an isPrimary
-- flag (exactly one per person, enforced by partial UNIQUE index).
--
-- iam_person.primary_phone stays as a denormalized cache of the
-- primary row's number — the service keeps it in sync on every
-- mutation so existing surfaces (family page guardian cards, EC
-- table, /profile/me Account tab's other readers) continue to read
-- the canonical primary without joining this new table per-call.
--
-- Backfill seeds one row per iam_person that already has a
-- primary_phone — type CELL, texts_allowed true, is_primary true.
-- New rows arriving via /auth/register that write only iam_person
-- get a lazy seed on the first GET /profile/me/phones call.

CREATE TABLE IF NOT EXISTS platform.platform_person_phones (
  id             UUID PRIMARY KEY,
  person_id      UUID NOT NULL REFERENCES platform.iam_person(id) ON DELETE CASCADE,
  number         TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'CELL',
  texts_allowed  BOOLEAN NOT NULL DEFAULT false,
  is_primary     BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ
);

ALTER TABLE platform.platform_person_phones
  DROP CONSTRAINT IF EXISTS platform_person_phones_type_check;

ALTER TABLE platform.platform_person_phones
  ADD CONSTRAINT platform_person_phones_type_check
  CHECK (type IN ('CELL', 'HOME', 'WORK', 'OTHER'));

-- Partial UNIQUE: at most one primary per person. Postgres treats
-- "is_primary = true" as the partial predicate so a person can have
-- many is_primary=false rows but only one is_primary=true.
CREATE UNIQUE INDEX IF NOT EXISTS platform_person_phones_one_primary_idx
  ON platform.platform_person_phones(person_id)
  WHERE is_primary = true;

CREATE INDEX IF NOT EXISTS platform_person_phones_person_idx
  ON platform.platform_person_phones(person_id, is_primary DESC, created_at);

-- Schools query "all parents who accept texts" for broadcast SMS.
-- Index on the opt-in flag keeps that fast.
CREATE INDEX IF NOT EXISTS platform_person_phones_texts_idx
  ON platform.platform_person_phones(texts_allowed)
  WHERE texts_allowed = true;

-- Backfill: one CELL row per existing iam_person that has a
-- primary_phone. Idempotent — uses ON CONFLICT on the partial
-- unique index in case the migration is re-run.
INSERT INTO platform.platform_person_phones (id, person_id, number, type, texts_allowed, is_primary)
SELECT
  gen_random_uuid(),
  ip.id,
  ip.primary_phone,
  'CELL',
  true,
  true
FROM platform.iam_person ip
WHERE ip.primary_phone IS NOT NULL AND ip.primary_phone <> ''
  AND NOT EXISTS (
    SELECT 1 FROM platform.platform_person_phones pp
    WHERE pp.person_id = ip.id
  );
