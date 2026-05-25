-- Placeholder guardian support on platform_family_members.
--
-- A "placeholder" row is a guardian the parent has named but who
-- doesn't have a CampusOS account yet — same pattern as
-- platform_family_children's PLACEHOLDER status. person_id is NULL
-- on the row; first_name / last_name / email carry the display
-- name and the invite-target address.
--
-- Lifecycle:
--   PLACEHOLDER     — person_id NULL, no invite outstanding
--   PENDING_INVITE  — person_id NULL, invite_code populated
--   ACTIVE          — person_id set (the canonical state — matches
--                     every row that existed before this migration,
--                     which is why ACTIVE is the DEFAULT)
--
-- Person_id becomes nullable. PostgreSQL UNIQUE treats NULL as
-- distinct by default, so the existing @unique(personId) and
-- @@unique([familyId, personId]) indexes still hold for ACTIVE rows
-- while allowing multiple NULLs (multiple placeholders) to coexist.
--
-- Idempotent — re-runs are no-ops.

ALTER TABLE platform.platform_family_members
  ALTER COLUMN person_id DROP NOT NULL;

ALTER TABLE platform.platform_family_members
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS invite_code TEXT,
  ADD COLUMN IF NOT EXISTS invite_sent_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_family_members_status_check'
  ) THEN
    ALTER TABLE platform.platform_family_members
      ADD CONSTRAINT platform_family_members_status_check
      CHECK (status IN ('PLACEHOLDER', 'PENDING_INVITE', 'ACTIVE'));
  END IF;
END $$;
