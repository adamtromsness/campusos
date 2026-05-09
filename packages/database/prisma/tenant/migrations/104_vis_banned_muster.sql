/*
  Phase 2 Cycle 1 (P2C1) Step 3 — Banned Persons + Emergency Muster

  M90 Visitor Management safety surface. Three tables:

  - vis_banned_persons — SAFETY KEYSTONE. The reception kiosk
    consults this table on every sign-in attempt. name_hash is an
    HMAC-SHA256 blind index of the normalised lowercase trimmed
    full name plus the date of birth (when supplied). A match
    blocks sign-in, displays a neutral "please see reception staff"
    message, and emits vis.banned_person.detected so the
    safeguarding officer is paged. The visitor never learns why
    they were blocked. Partial INDEX on (school_id, name_hash)
    WHERE is_active = true backs the kiosk lookup. ban_type is a
    5-value CHECK aligned to the policy/legal taxonomy. Plaintext
    first_name + last_name are visible only to admins holding the
    safeguarding_ban:read permission.

  - vis_emergency_muster — one row per emergency snapshot (fire
    drill, lockdown, evacuation). total_on_site_at_snapshot is
    frozen at creation time. incident_id is a soft ref to the
    future inc_incidents table (M91 — schema not yet built).

  - vis_muster_entries — per-visitor accountability tracker.
    visitor_name + visitor_type + building are SNAPSHOT fields,
    frozen at muster creation time so the row remains meaningful
    even if the underlying vis_visitors / vis_visitor_types row
    is later updated. UNIQUE(muster_id, sign_in_id) so the same
    visitor cannot be double-counted in a snapshot. 4-value
    status CHECK starts at UNKNOWN and reception staff mark each
    person as ACCOUNTED_FOR / EVACUATED / ASSISTANCE_NEEDED as
    they are located.

  No cross-schema FKs. school_id, added_by, reviewed_by,
  created_by are soft refs to platform.platform_users(id) per
  ADR-001 / ADR-020.
*/

CREATE TABLE IF NOT EXISTS vis_banned_persons (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  date_of_birth DATE,
  name_hash TEXT NOT NULL,
  photo_s3_key TEXT,
  ban_reason TEXT NOT NULL,
  ban_type TEXT NOT NULL,
  ban_order_s3_key TEXT,
  added_by UUID NOT NULL,
  reviewed_by UUID,
  last_reviewed_at DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vis_banned_type_chk CHECK (
    ban_type IN ('COURT_ORDER', 'SCHOOL_DECISION', 'SAFEGUARDING', 'RESTRAINING_ORDER', 'OTHER')
  ),
  CONSTRAINT vis_banned_dates_chk CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  ),
  CONSTRAINT vis_banned_reason_nonempty_chk CHECK (length(trim(ban_reason)) > 0)
);

CREATE INDEX IF NOT EXISTS vis_banned_kiosk_lookup_idx
  ON vis_banned_persons (school_id, name_hash) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS vis_banned_school_active_idx
  ON vis_banned_persons (school_id) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS vis_banned_review_due_idx
  ON vis_banned_persons (school_id, last_reviewed_at NULLS FIRST)
  WHERE is_active = true;

COMMENT ON TABLE vis_banned_persons IS
  'SAFETY KEYSTONE — banned persons registry consulted by the kiosk on every sign-in attempt. name_hash is HMAC-SHA256 of normalised name plus DOB. Partial INDEX(school_id, name_hash) WHERE is_active = true backs the real-time kiosk lookup.';

COMMENT ON COLUMN vis_banned_persons.name_hash IS
  'HMAC-SHA256 blind index. Computed from lowercase trimmed first_name + space + last_name + (DOB ISO string when supplied). Equality lookup at the kiosk. Plaintext first_name + last_name are visible only to admins with safeguarding_ban:read.';

COMMENT ON COLUMN vis_banned_persons.ban_type IS
  '5-value CHECK COURT_ORDER / SCHOOL_DECISION / SAFEGUARDING / RESTRAINING_ORDER / OTHER. COURT_ORDER and RESTRAINING_ORDER must reference a ban_order_s3_key uploaded document for compliance evidence.';

COMMENT ON COLUMN vis_banned_persons.ban_order_s3_key IS
  'Optional S3 reference for the supporting court order or restraining order PDF. Plaintext name + this document together are gated on safeguarding_ban:read — never exposed to non-admin staff.';


CREATE TABLE IF NOT EXISTS vis_emergency_muster (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  incident_id UUID,
  drill_type TEXT NOT NULL DEFAULT 'FIRE_DRILL',
  description TEXT,
  created_by UUID NOT NULL,
  total_on_site_at_snapshot INT NOT NULL,
  closed_at TIMESTAMPTZ,
  closed_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vis_muster_drill_chk CHECK (
    drill_type IN ('FIRE_DRILL', 'LOCKDOWN', 'EVACUATION', 'BOMB_THREAT', 'WEATHER', 'OTHER')
  ),
  CONSTRAINT vis_muster_total_nonneg_chk CHECK (total_on_site_at_snapshot >= 0)
);

CREATE INDEX IF NOT EXISTS vis_muster_school_created_idx
  ON vis_emergency_muster (school_id, created_at DESC);

CREATE INDEX IF NOT EXISTS vis_muster_open_idx
  ON vis_emergency_muster (school_id, created_at DESC)
  WHERE closed_at IS NULL;

COMMENT ON TABLE vis_emergency_muster IS
  'Emergency muster snapshot. One row per drill / real incident. total_on_site_at_snapshot frozen at creation time. incident_id is a soft ref to the future inc_incidents (M91) table.';

COMMENT ON COLUMN vis_emergency_muster.drill_type IS
  '6-value CHECK FIRE_DRILL / LOCKDOWN / EVACUATION / BOMB_THREAT / WEATHER / OTHER. Drives the per-snapshot summary view colour and headline.';


CREATE TABLE IF NOT EXISTS vis_muster_entries (
  id UUID PRIMARY KEY,
  muster_id UUID NOT NULL,
  sign_in_id UUID NOT NULL,
  visitor_name TEXT NOT NULL,
  visitor_type TEXT NOT NULL,
  visitor_company TEXT,
  building TEXT,
  status TEXT NOT NULL DEFAULT 'UNKNOWN',
  notes TEXT,
  marked_by UUID,
  marked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vis_muster_entry_status_chk CHECK (
    status IN ('UNKNOWN', 'ACCOUNTED_FOR', 'EVACUATED', 'ASSISTANCE_NEEDED')
  ),
  CONSTRAINT vis_muster_entry_marked_chk CHECK (
    (status = 'UNKNOWN' AND marked_by IS NULL AND marked_at IS NULL)
    OR (status <> 'UNKNOWN' AND marked_by IS NOT NULL AND marked_at IS NOT NULL)
  ),
  CONSTRAINT vis_muster_entry_muster_fk
    FOREIGN KEY (muster_id) REFERENCES vis_emergency_muster(id) ON DELETE CASCADE,
  CONSTRAINT vis_muster_entry_signin_fk
    FOREIGN KEY (sign_in_id) REFERENCES vis_sign_ins(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS vis_muster_entry_uq
  ON vis_muster_entries (muster_id, sign_in_id);

CREATE INDEX IF NOT EXISTS vis_muster_entry_status_idx
  ON vis_muster_entries (muster_id, status);

COMMENT ON TABLE vis_muster_entries IS
  'Per-visitor accountability row inside a muster snapshot. visitor_name + visitor_type + building are SNAPSHOT fields, frozen at creation time. UNIQUE(muster_id, sign_in_id). 4-value status CHECK UNKNOWN to ACCOUNTED_FOR / EVACUATED / ASSISTANCE_NEEDED.';

COMMENT ON CONSTRAINT vis_muster_entry_marked_chk ON vis_muster_entries IS
  'Multi-column lockstep — UNKNOWN status requires marked_by + marked_at NULL. Any non-UNKNOWN status requires both populated. Reception staff cannot mark a visitor without identifying themselves and the time.';
