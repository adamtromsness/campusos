/*
 * 061_grp_groups_members.sql — Cycle 18 Step 1.
 *
 * M103 Groups and Communities domain 1: groups with scope-aware
 * binding, membership with the OWNER/ADMIN/MEMBER role hierarchy and
 * 6-state lifecycle, per-member notification preferences, and the
 * two-party ownership transfer handshake.
 *
 * Soft FKs to platform.iam_person and platform.platform_users per
 * ADR-001 / ADR-020. The grp_groups.scope_id column is a soft
 * polymorphic ref resolved by scope_type at the application layer
 * (CLASS -> sis_classes, YEAR_GROUP -> sis_academic_years,
 * ACTIVITY -> ext_activities — SCHOOL and CUSTOM leave scope_id NULL).
 *
 * No semicolons inside string literals or block comments — the tenant
 * provisioner splits on the semicolon character regardless of context.
 */

CREATE TABLE IF NOT EXISTS grp_groups (
  id                  UUID PRIMARY KEY,
  school_id           UUID NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT,
  scope_type          TEXT NOT NULL,
  scope_id            UUID,
  status              TEXT NOT NULL DEFAULT 'ACTIVE',
  join_policy         TEXT NOT NULL DEFAULT 'OPEN',
  auto_dissolve_at    TIMESTAMPTZ,
  created_by          UUID NOT NULL,
  avatar_url          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT grp_groups_scope_chk CHECK (
    scope_type IN ('CLASS', 'YEAR_GROUP', 'SCHOOL', 'CUSTOM', 'ACTIVITY')
  ),
  CONSTRAINT grp_groups_status_chk CHECK (status IN ('ACTIVE', 'ARCHIVED', 'DISSOLVED')),
  CONSTRAINT grp_groups_policy_chk CHECK (
    join_policy IN ('OPEN', 'APPROVAL_REQUIRED', 'INVITE_ONLY')
  ),
  CONSTRAINT grp_groups_scope_pair_chk CHECK (
    (scope_type IN ('SCHOOL', 'CUSTOM') AND scope_id IS NULL)
    OR (scope_type IN ('CLASS', 'YEAR_GROUP', 'ACTIVITY') AND scope_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS grp_groups_school_status_idx
  ON grp_groups (school_id, status);
CREATE INDEX IF NOT EXISTS grp_groups_scope_idx
  ON grp_groups (scope_type, scope_id);
CREATE INDEX IF NOT EXISTS grp_groups_dissolve_idx
  ON grp_groups (auto_dissolve_at)
  WHERE auto_dissolve_at IS NOT NULL AND status = 'ACTIVE';

COMMENT ON TABLE grp_groups IS
  'Group container. scope_type drives the soft polymorphic resolution of scope_id at the application layer. multi-column scope_pair_chk enforces the SCHOOL/CUSTOM scope_id-null pairing. Partial INDEX(auto_dissolve_at) backs the future Phase 3 dissolve-sweep cron.';

CREATE TABLE IF NOT EXISTS grp_members (
  id                    UUID PRIMARY KEY,
  group_id              UUID NOT NULL,
  person_id             UUID NOT NULL,
  member_role           TEXT NOT NULL DEFAULT 'MEMBER',
  status                TEXT NOT NULL DEFAULT 'ACTIVE',
  joined_at             TIMESTAMPTZ,
  invited_by            UUID,
  left_at               TIMESTAMPTZ,
  suspension_reason     TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT grp_members_role_chk CHECK (member_role IN ('OWNER', 'ADMIN', 'MEMBER')),
  CONSTRAINT grp_members_status_chk CHECK (
    status IN ('ACTIVE', 'INVITED', 'PENDING_APPROVAL', 'SUSPENDED', 'LEFT', 'REMOVED')
  ),
  CONSTRAINT grp_members_left_chk CHECK (
    (status = 'LEFT' AND left_at IS NOT NULL)
    OR (status <> 'LEFT' AND left_at IS NULL)
  ),
  CONSTRAINT grp_members_group_fk FOREIGN KEY (group_id)
    REFERENCES grp_groups(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS grp_members_active_uq
  ON grp_members (group_id, person_id)
  WHERE status <> 'LEFT';

CREATE INDEX IF NOT EXISTS grp_members_person_active_idx
  ON grp_members (person_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS grp_members_admin_roster_idx
  ON grp_members (group_id, member_role)
  WHERE member_role IN ('OWNER', 'ADMIN');

COMMENT ON TABLE grp_members IS
  'Membership row with 3-tier role hierarchy and 6-state lifecycle. Partial UNIQUE(group_id, person_id) WHERE status <> LEFT caps an active membership at one row but allows re-join after voluntary leave. left_chk lockstep keeps left_at in sync with the LEFT status.';

CREATE TABLE IF NOT EXISTS grp_member_notification_prefs (
  id                            UUID PRIMARY KEY,
  membership_id                 UUID NOT NULL UNIQUE,
  notify_announcements          BOOLEAN NOT NULL DEFAULT true,
  notify_events                 BOOLEAN NOT NULL DEFAULT true,
  notify_membership_changes     BOOLEAN NOT NULL DEFAULT false,
  notify_results                BOOLEAN NOT NULL DEFAULT true,
  preferred_channel             TEXT NOT NULL DEFAULT 'IN_APP',
  quiet_hours_override          BOOLEAN NOT NULL DEFAULT false,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT grp_prefs_channel_chk CHECK (
    preferred_channel IN ('IN_APP', 'EMAIL', 'PUSH', 'ALL', 'NONE')
  ),
  CONSTRAINT grp_prefs_member_fk FOREIGN KEY (membership_id)
    REFERENCES grp_members(id) ON DELETE CASCADE
);

COMMENT ON TABLE grp_member_notification_prefs IS
  'Per-member per-group notification toggles. UNIQUE on membership_id keeps the prefs row 1-to-1 with the membership row. CASCADE on parent member delete drops the prefs row.';

CREATE TABLE IF NOT EXISTS grp_ownership_transfers (
  id                  UUID PRIMARY KEY,
  group_id            UUID NOT NULL,
  from_member_id      UUID NOT NULL,
  to_member_id        UUID NOT NULL,
  transfer_reason     TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING',
  initiated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  responded_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT grp_transfer_status_chk CHECK (
    status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED')
  ),
  CONSTRAINT grp_transfer_responded_chk CHECK (
    (status = 'PENDING' AND responded_at IS NULL)
    OR (status IN ('ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED') AND responded_at IS NOT NULL)
  ),
  CONSTRAINT grp_transfer_window_chk CHECK (expires_at > initiated_at),
  CONSTRAINT grp_transfer_distinct_chk CHECK (from_member_id <> to_member_id),
  CONSTRAINT grp_transfer_group_fk FOREIGN KEY (group_id)
    REFERENCES grp_groups(id) ON DELETE CASCADE,
  CONSTRAINT grp_transfer_from_fk FOREIGN KEY (from_member_id)
    REFERENCES grp_members(id) ON DELETE NO ACTION,
  CONSTRAINT grp_transfer_to_fk FOREIGN KEY (to_member_id)
    REFERENCES grp_members(id) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS grp_transfer_pending_uq
  ON grp_ownership_transfers (group_id)
  WHERE status = 'PENDING';

COMMENT ON TABLE grp_ownership_transfers IS
  'TWO-PARTY HANDSHAKE keystone. Partial UNIQUE(group_id) WHERE status=PENDING caps pending transfers at one per group. Multi-column responded_chk keeps responded_at in lockstep with the terminal statuses. NO ACTION on from/to member FKs preserves audit when a member is removed during a pending transfer (the transfer expires naturally).';
