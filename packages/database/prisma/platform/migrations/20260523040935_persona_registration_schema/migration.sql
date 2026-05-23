-- Persona Registration Schema
--
-- New tables for the persona, registration & child management design:
--   - platform_family_children — parent's view of their children
--     before any school relationship (PLACEHOLDER → PENDING_LINK → LINKED)
--   - platform_personas — cached persona set per person, derived from
--     projection tables (LINKED children, hr_employees, sis_students,
--     sub_profiles, alm_profiles, grp_members)
--   - platform_invitations — generic invite envelope for employee offers,
--     child-link codes, parent-link from school, and substitute onboarding
--
-- platform_users gains is_minor_account + managed_by_person_id for
-- parent-managed under-13 accounts (COPPA / FERPA).
--
-- Additive only. Idempotent.

-- ── platform_users — minor account support ────────────────────
ALTER TABLE platform.platform_users
  ADD COLUMN IF NOT EXISTS is_minor_account BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS managed_by_person_id UUID;

CREATE INDEX IF NOT EXISTS "platform_users_managed_by_person_id_idx"
  ON platform.platform_users (managed_by_person_id);

-- ── platform_family_children ──────────────────────────────────
CREATE TABLE IF NOT EXISTS platform.platform_family_children (
  id              UUID PRIMARY KEY,
  family_id       UUID NOT NULL REFERENCES platform.platform_families(id),
  person_id       UUID REFERENCES platform.iam_person(id),
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  date_of_birth   DATE,
  gender          TEXT,
  status          TEXT NOT NULL DEFAULT 'PLACEHOLDER',
  invite_code     TEXT,
  invite_email    TEXT,
  invite_sent_at  TIMESTAMPTZ,
  linked_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ,
  CONSTRAINT platform_family_children_status_check
    CHECK (status IN ('PLACEHOLDER', 'PENDING_LINK', 'LINKED'))
);

-- Partial UNIQUE so multiple PLACEHOLDER children (person_id IS NULL) can
-- coexist in the same family while still preventing duplicate links.
CREATE UNIQUE INDEX IF NOT EXISTS "platform_family_children_family_person_uq"
  ON platform.platform_family_children (family_id, person_id)
  WHERE person_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS "platform_family_children_family_id_status_idx"
  ON platform.platform_family_children (family_id, status);

CREATE INDEX IF NOT EXISTS "platform_family_children_person_id_idx"
  ON platform.platform_family_children (person_id);

CREATE INDEX IF NOT EXISTS "platform_family_children_invite_code_idx"
  ON platform.platform_family_children (invite_code);

-- ── platform_personas ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform.platform_personas (
  id          UUID PRIMARY KEY,
  person_id   UUID NOT NULL REFERENCES platform.iam_person(id),
  type        TEXT NOT NULL,
  school_id   UUID REFERENCES platform.schools(id),
  label       TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT platform_personas_type_check
    CHECK (type IN ('PARENT', 'STUDENT', 'STAFF', 'SUBSTITUTE', 'ALUMNI', 'COMMUNITY'))
);

-- UNIQUE (person_id, type, school_id) with COALESCE so null school_id rows
-- (platform-wide personas) still de-dup. Prisma can't express this so it
-- lives only here; the service layer relies on it for UPSERTs.
CREATE UNIQUE INDEX IF NOT EXISTS "platform_personas_person_type_school_uq"
  ON platform.platform_personas (
    person_id,
    type,
    COALESCE(school_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS "platform_personas_person_id_is_active_idx"
  ON platform.platform_personas (person_id, is_active);

CREATE INDEX IF NOT EXISTS "platform_personas_person_id_type_idx"
  ON platform.platform_personas (person_id, type);

CREATE INDEX IF NOT EXISTS "platform_personas_school_id_idx"
  ON platform.platform_personas (school_id);

-- ── platform_invitations ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform.platform_invitations (
  id                UUID PRIMARY KEY,
  type              TEXT NOT NULL,
  token             TEXT NOT NULL UNIQUE,
  inviter_person_id UUID NOT NULL REFERENCES platform.iam_person(id),
  target_email      TEXT,
  target_person_id  UUID REFERENCES platform.iam_person(id),
  metadata          JSONB,
  status            TEXT NOT NULL DEFAULT 'PENDING',
  expires_at        TIMESTAMPTZ NOT NULL,
  accepted_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT platform_invitations_type_check
    CHECK (type IN ('EMPLOYEE', 'CHILD_LINK', 'PARENT_LINK', 'SUBSTITUTE')),
  CONSTRAINT platform_invitations_status_check
    CHECK (status IN ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED'))
);

CREATE INDEX IF NOT EXISTS "platform_invitations_inviter_person_id_status_idx"
  ON platform.platform_invitations (inviter_person_id, status);

CREATE INDEX IF NOT EXISTS "platform_invitations_target_email_idx"
  ON platform.platform_invitations (target_email);

CREATE INDEX IF NOT EXISTS "platform_invitations_status_expires_at_idx"
  ON platform.platform_invitations (status, expires_at);
