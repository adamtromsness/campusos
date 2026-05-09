/*
  Phase 2 Cycle 1 (P2C1) Step 1 — Visitor Types + Visitors + Sign-In Settings

  M90 Visitor Management foundation. Three tables:

  - vis_visitor_types — per-school visitor category catalogue. Each
    category controls whether the visitor needs a safeguarding check
    on entry and what colour the printed badge should be. UNIQUE on
    (school_id, name) so the same school cannot ship two "Contractor"
    rows. is_active flag for soft deactivation when a category is
    retired.

  - vis_visitors — directory of every person who has ever signed in.
    SECURITY KEYSTONE — PII at rest is encrypted. email_encrypted
    and phone_encrypted hold AES-256-GCM ciphertext (the same wire
    format Cycle 22 IT vault uses for credentials). email_hash and
    phone_hash are HMAC-SHA256 blind indexes so the kiosk can match
    a returning visitor by typing their email without ever
    decrypting the encrypted column. UNIQUE(school_id, email_hash)
    is the schema-side dedup gate. The plaintext columns are write-
    only at the service layer (only the admin profile endpoint
    decrypts them) — kiosk lookup queries return visitor id + name
    + type only.

  - vis_sign_in_settings — per-school configuration row. UNIQUE on
    school_id so each school has exactly one settings record. Drives
    kiosk behaviour — purpose required, photo ID required, badge
    template, safeguarding provider name, auto sign-out after N
    hours.

  No cross-schema FKs. school_id is a soft ref to platform.schools
  per ADR-001 / ADR-020. visitor_type_id is the only intra-tenant
  FK in this migration (vis_visitors → vis_visitor_types, ON DELETE
  RESTRICT — admin must reassign visitors before retiring a type).
*/

CREATE TABLE IF NOT EXISTS vis_visitor_types (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  requires_safeguarding_check BOOLEAN NOT NULL DEFAULT true,
  badge_color TEXT NOT NULL DEFAULT 'blue',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vis_vt_badge_chk CHECK (
    badge_color IN ('blue', 'green', 'amber', 'rose', 'purple', 'gray')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS vis_vt_school_name_uq
  ON vis_visitor_types (school_id, name);

CREATE INDEX IF NOT EXISTS vis_vt_school_active_idx
  ON vis_visitor_types (school_id) WHERE is_active = true;

COMMENT ON TABLE vis_visitor_types IS
  'Per-school visitor categories. UNIQUE(school_id, name). requires_safeguarding_check drives the Step 5 SignInService kiosk flow — when true, the visitor must have a non-null safeguarding_check_status before sign-in is accepted.';

COMMENT ON COLUMN vis_visitor_types.badge_color IS
  '6-value CHECK aligned to the kiosk + reception UI palette. Drives the printed badge colour and the on-screen pill.';


CREATE TABLE IF NOT EXISTS vis_visitors (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  visitor_type_id UUID NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  company TEXT,
  email_encrypted TEXT,
  email_hash TEXT NOT NULL,
  phone_encrypted TEXT,
  phone_hash TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vis_visitor_email_hash_nonempty_chk CHECK (length(email_hash) > 0),
  CONSTRAINT vis_visitor_visitor_type_fk
    FOREIGN KEY (visitor_type_id) REFERENCES vis_visitor_types(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS vis_visitor_school_email_hash_uq
  ON vis_visitors (school_id, email_hash);

CREATE INDEX IF NOT EXISTS vis_visitor_email_hash_idx
  ON vis_visitors (email_hash);

CREATE INDEX IF NOT EXISTS vis_visitor_phone_hash_idx
  ON vis_visitors (phone_hash) WHERE phone_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS vis_visitor_school_name_idx
  ON vis_visitors (school_id, last_name, first_name);

COMMENT ON TABLE vis_visitors IS
  'Directory of every person who has signed in to the school. SECURITY KEYSTONE — email + phone PII are encrypted at rest (AES-256-GCM). email_hash + phone_hash are HMAC-SHA256 blind indexes for kiosk returning-visitor lookup. UNIQUE(school_id, email_hash) is the dedup gate.';

COMMENT ON COLUMN vis_visitors.email_encrypted IS
  'AES-256-GCM ciphertext of the visitor email. Wire format base64(iv).base64(tag).base64(ciphertext) — same shape as Cycle 22 tech_credential_vault.encrypted_password.';

COMMENT ON COLUMN vis_visitors.email_hash IS
  'HMAC-SHA256 blind index of the lower-cased trimmed email. Equality lookup at the kiosk: SELECT WHERE email_hash = hmac(input_email, secret). Never reveals the plaintext.';

COMMENT ON COLUMN vis_visitors.phone_encrypted IS
  'AES-256-GCM ciphertext of the visitor phone number. Optional — many walk-up visitors do not give a phone.';

COMMENT ON COLUMN vis_visitors.phone_hash IS
  'HMAC-SHA256 blind index of the normalised phone digits (E.164-ish). Optional partial INDEX backs phone-based returning-visitor lookup at the kiosk.';

COMMENT ON COLUMN vis_visitors.visitor_type_id IS
  'FK to vis_visitor_types(id) ON DELETE RESTRICT. Admin must reassign visitors before retiring a type — soft deactivation via vis_visitor_types.is_active is the recommended path.';


CREATE TABLE IF NOT EXISTS vis_sign_in_settings (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  require_photo_id BOOLEAN NOT NULL DEFAULT false,
  require_purpose BOOLEAN NOT NULL DEFAULT true,
  auto_sign_out_hours INT NOT NULL DEFAULT 12,
  safeguarding_provider TEXT,
  badge_template TEXT NOT NULL DEFAULT 'STANDARD',
  kiosk_welcome_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vis_settings_auto_signout_chk CHECK (auto_sign_out_hours > 0 AND auto_sign_out_hours <= 48),
  CONSTRAINT vis_settings_badge_template_chk CHECK (
    badge_template IN ('STANDARD', 'COMPACT', 'PHOTO')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS vis_settings_school_uq
  ON vis_sign_in_settings (school_id);

COMMENT ON TABLE vis_sign_in_settings IS
  'Per-school visitor sign-in configuration. UNIQUE(school_id). auto_sign_out_hours bounded at 48 because anything longer means the visitor probably forgot to sign out and the system should still close the loop.';
