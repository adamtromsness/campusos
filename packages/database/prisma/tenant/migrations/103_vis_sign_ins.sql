/*
  Phase 2 Cycle 1 (P2C1) Step 2 — Sign-Ins + Pre-Registrations + Recurring

  M90 Visitor Management operational layer. Three tables:

  - vis_sign_ins — every sign-in event. The active-on-site partial
    INDEX(school_id, signed_in_at) WHERE signed_out_at IS NULL is the
    EMERGENCY MUSTER QUERY KEYSTONE — the Step 7 muster snapshot
    walks this index in one batch INSERT to materialise vis_muster_entries
    rows for everyone currently on-site. signed_out_at IS NULL means
    "still here". 4-value safeguarding_check_status CHECK
    (PASSED / FLAGGED / BYPASSED_BY_ADMIN / NOT_REQUIRED). The
    BYPASS contract is enforced by a multi-column CHECK — a row with
    status=BYPASSED_BY_ADMIN must carry bypass_admin_id + bypass_reason
    populated, and bypass_reason must be more than 10 characters
    (whitespace trimmed) so a one-word "ok" cannot bypass safeguarding.
    safeguarding_check_ref stores the third-party reference ID only
    per ADR-015 — never the registry payload itself.

  - vis_pre_registrations — staff-initiated expected-visitor records.
    qr_code_token UNIQUE so every QR code corresponds to exactly one
    pre-reg. Partial INDEX(expires_at) WHERE used_at IS NULL backs
    the kiosk QR scan keystone (single-row lookup keyed on the token).
    Cleanup job deletes WHERE expires_at < now() AND used_at IS NULL.

  - vis_recurring_visitors — regular contractors with a JSONB
    access_schedule (days/times). GIN INDEX on access_schedule for
    JSONB containment queries. Per-(visitor, valid_from, valid_to)
    INDEX so the Step 6 RecurringVisitorService.today() endpoint can
    answer "who is expected today" without scanning every recurring
    row.

  All FKs are intra-tenant. host_id, bypass_admin_id, approved_by
  are soft refs to platform.platform_users(id) per ADR-001 / ADR-020
  (no DB FK — the request services validate at the application layer
  via assertAccountInCurrentTenant). building_id is a soft ref to
  fac_buildings(id) — nullable because a sign-in does not require
  a building selection.
*/

CREATE TABLE IF NOT EXISTS vis_sign_ins (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  visitor_id UUID NOT NULL,
  signed_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  signed_out_at TIMESTAMPTZ,
  host_id UUID,
  purpose TEXT,
  building_id UUID,
  pre_registration_id UUID,
  badge_number TEXT,
  safeguarding_check_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
  safeguarding_check_ref TEXT,
  bypass_admin_id UUID,
  bypass_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vis_si_visitor_fk
    FOREIGN KEY (visitor_id) REFERENCES vis_visitors(id) ON DELETE RESTRICT,
  CONSTRAINT vis_si_status_chk CHECK (
    safeguarding_check_status IN ('PASSED', 'FLAGGED', 'BYPASSED_BY_ADMIN', 'NOT_REQUIRED')
  ),
  CONSTRAINT vis_si_signed_out_chk CHECK (
    signed_out_at IS NULL OR signed_out_at >= signed_in_at
  ),
  CONSTRAINT vis_si_bypass_chk CHECK (
    safeguarding_check_status <> 'BYPASSED_BY_ADMIN'
    OR (
      bypass_admin_id IS NOT NULL
      AND bypass_reason IS NOT NULL
      AND length(trim(bypass_reason)) > 10
    )
  )
);

CREATE INDEX IF NOT EXISTS vis_si_active_idx
  ON vis_sign_ins (school_id, signed_in_at) WHERE signed_out_at IS NULL;

CREATE INDEX IF NOT EXISTS vis_si_visitor_idx
  ON vis_sign_ins (visitor_id, signed_in_at DESC);

CREATE INDEX IF NOT EXISTS vis_si_host_idx
  ON vis_sign_ins (host_id, signed_in_at DESC) WHERE host_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS vis_si_signed_in_brin_idx
  ON vis_sign_ins USING brin (signed_in_at);

COMMENT ON TABLE vis_sign_ins IS
  'Every sign-in event. Partial INDEX(school_id, signed_in_at) WHERE signed_out_at IS NULL is the EMERGENCY MUSTER QUERY KEYSTONE — Step 7 MusterService walks this index in one batch INSERT. BRIN on signed_in_at for historical compliance reports.';

COMMENT ON COLUMN vis_sign_ins.safeguarding_check_status IS
  '4-value CHECK PASSED / FLAGGED / BYPASSED_BY_ADMIN / NOT_REQUIRED. NOT_REQUIRED for visitor types whose vis_visitor_types.requires_safeguarding_check=false (parents, etc.). FLAGGED triggers a reception-staff prompt and never lets the visitor through unattended.';

COMMENT ON COLUMN vis_sign_ins.safeguarding_check_ref IS
  'Third-party reference ID ONLY per ADR-015 — DBS / background-check registry data is never persisted by CampusOS. Schools store the lookup id and re-query the registry directly when audit is needed.';

COMMENT ON CONSTRAINT vis_si_bypass_chk ON vis_sign_ins IS
  'Multi-column lockstep — BYPASSED_BY_ADMIN status requires bypass_admin_id + bypass_reason populated AND bypass_reason length more than 10 characters (whitespace trimmed). A one-word "ok" cannot bypass safeguarding.';


CREATE TABLE IF NOT EXISTS vis_pre_registrations (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  visitor_id UUID NOT NULL,
  expected_at TIMESTAMPTZ NOT NULL,
  purpose TEXT,
  host_id UUID,
  qr_code_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vis_prereg_visitor_fk
    FOREIGN KEY (visitor_id) REFERENCES vis_visitors(id) ON DELETE RESTRICT,
  CONSTRAINT vis_prereg_expires_after_expected_chk CHECK (expires_at >= expected_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS vis_prereg_qr_uq
  ON vis_pre_registrations (qr_code_token);

CREATE INDEX IF NOT EXISTS vis_prereg_active_idx
  ON vis_pre_registrations (expires_at) WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS vis_prereg_school_expected_idx
  ON vis_pre_registrations (school_id, expected_at)
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS vis_prereg_visitor_idx
  ON vis_pre_registrations (visitor_id, expected_at DESC);

COMMENT ON TABLE vis_pre_registrations IS
  'Staff-initiated expected-visitor records. UNIQUE qr_code_token. Partial INDEX(expires_at) WHERE used_at IS NULL is the kiosk QR scan keystone — single-row lookup. Cleanup: DELETE WHERE expires_at less than now() AND used_at IS NULL.';

COMMENT ON COLUMN vis_pre_registrations.qr_code_token IS
  '32-byte hex token generated via crypto.randomBytes(32).toString("hex"). Cryptographically unguessable — the kiosk POST /pre-register/scan endpoint is the only resolver. Stamped used_at on first successful scan, and a second scan returns 410 Gone.';


CREATE TABLE IF NOT EXISTS vis_recurring_visitors (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  visitor_id UUID NOT NULL,
  access_schedule JSONB NOT NULL DEFAULT '{}'::jsonb,
  valid_from DATE NOT NULL,
  valid_to DATE,
  approved_by UUID NOT NULL,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vis_recur_visitor_fk
    FOREIGN KEY (visitor_id) REFERENCES vis_visitors(id) ON DELETE RESTRICT,
  CONSTRAINT vis_recur_dates_chk CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE INDEX IF NOT EXISTS vis_recur_visitor_idx
  ON vis_recurring_visitors (visitor_id, valid_from, valid_to);

CREATE INDEX IF NOT EXISTS vis_recur_school_active_idx
  ON vis_recurring_visitors (school_id) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS vis_recur_schedule_gin_idx
  ON vis_recurring_visitors USING gin (access_schedule);

COMMENT ON TABLE vis_recurring_visitors IS
  'Regular contractors with a recurring schedule. access_schedule JSONB carries days + time windows (e.g. {"days": ["MON", "WED"], "time_start": "08:00", "time_end": "16:00"}). GIN INDEX backs the Step 6 today() lookup query.';

COMMENT ON COLUMN vis_recurring_visitors.access_schedule IS
  'JSONB shape: { "days": ["MON","TUE","WED","THU","FRI","SAT","SUN"], "time_start": "HH:MM", "time_end": "HH:MM" }. Step 6 RecurringVisitorService validates the shape at the application layer.';
