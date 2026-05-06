/* ============================================================
 * Cycle 22 — Step 2: Licences + Credential Vault
 * ============================================================
 *
 * 4 logical base tables:
 *
 *   - tech_software_licences — software licence registry with
 *     PER_SEAT / SITE / SUBSCRIPTION variants. seats_chk caps
 *     used_seats <= total_seats when total_seats is set.
 *   - tech_software_assignments — per-(licence, user) assignment.
 *     UNIQUE caps to one assignment per (licence, user). The
 *     Step 6 LicenceService increments / decrements
 *     tech_software_licences.used_seats inside the same tenant
 *     tx that writes the assignment row.
 *   - tech_credential_vault — SECURITY KEYSTONE per ADR-065.
 *     Stores AES-256-encrypted shared service credentials with
 *     tiered access (STANDARD / ELEVATED / CRITICAL). The schema
 *     does not store the encryption key — the Step 6 service
 *     derives it from process.env.IT_VAULT_KEY and applies
 *     AES-256-GCM via Node crypto.
 *   - tech_credential_access_log — IMMUTABLE per ADR-010 audit
 *     trail. NO UPDATE, NO DELETE methods on the service surface.
 *     Mirrors Cycle 8 tkt_ticket_activity + Cycle 21
 *     fac_work_order_activity append-only patterns.
 *
 * Splitter-safe — no semicolons inside string literals or block
 * comments. Idempotent — re-runs are a no-op.
 * ============================================================ */

CREATE TABLE IF NOT EXISTS tech_software_licences (
  id                    UUID PRIMARY KEY,
  school_id             UUID NOT NULL,
  software_name         TEXT NOT NULL,
  vendor                TEXT,
  licence_type          TEXT NOT NULL,
  total_seats           INT,
  used_seats            INT NOT NULL DEFAULT 0,
  expiry_date           DATE,
  annual_cost           NUMERIC(10,2),
  notes                 TEXT,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  created_by            UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_lic_type_chk CHECK (
    licence_type IN ('PER_SEAT', 'SITE', 'SUBSCRIPTION')
  ),
  CONSTRAINT tech_lic_seats_chk CHECK (
    used_seats >= 0
    AND (total_seats IS NULL OR (total_seats > 0 AND used_seats <= total_seats))
  ),
  CONSTRAINT tech_lic_cost_chk CHECK (annual_cost IS NULL OR annual_cost >= 0),
  CONSTRAINT tech_lic_uq UNIQUE (school_id, software_name)
);

CREATE INDEX IF NOT EXISTS tech_lic_school_expiry_idx
  ON tech_software_licences (school_id, expiry_date);

CREATE INDEX IF NOT EXISTS tech_lic_active_idx
  ON tech_software_licences (school_id, is_active);

COMMENT ON TABLE tech_software_licences IS
  'Software licence registry. 3-value licence_type CHECK (PER_SEAT, SITE, SUBSCRIPTION). Multi-column seats_chk caps used_seats >= 0 for every licence and used_seats <= total_seats when total_seats is set (SITE licences leave total_seats NULL — unlimited). UNIQUE(school_id, software_name) so the software name is the stable handle. The Step 6 LicenceService emits tech.licence.near_capacity when used_seats / total_seats >= 0.80 after assignment commits.';

CREATE TABLE IF NOT EXISTS tech_software_assignments (
  id                   UUID PRIMARY KEY,
  licence_id           UUID NOT NULL,
  assignee_id          UUID NOT NULL,
  assigned_by          UUID NOT NULL,
  assigned_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at         TIMESTAMPTZ,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_lic_assign_uq UNIQUE (licence_id, assignee_id),
  CONSTRAINT tech_lic_assign_lic_fk FOREIGN KEY (licence_id)
    REFERENCES tech_software_licences(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tech_lic_assign_assignee_idx
  ON tech_software_assignments (assignee_id);

CREATE INDEX IF NOT EXISTS tech_lic_assign_lic_idx
  ON tech_software_assignments (licence_id, assigned_at DESC);

COMMENT ON TABLE tech_software_assignments IS
  'Per-(licence, user) software licence assignment. UNIQUE(licence_id, assignee_id) caps to one assignment per (licence, user) — re-assigning the same licence to the same user is a no-op. CASCADE on parent licence since assignments are meaningless without their licence. assignee_id is a soft FK to platform.platform_users per ADR-001/020. The Step 6 LicenceService increments tech_software_licences.used_seats inside the same tenant tx that writes the assignment row, and decrements it on DELETE.';

CREATE TABLE IF NOT EXISTS tech_credential_vault (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  service_name             TEXT NOT NULL,
  credential_type          TEXT NOT NULL,
  username                 TEXT,
  encrypted_password       TEXT NOT NULL,
  url                      TEXT,
  last_rotated_at          TIMESTAMPTZ,
  rotation_due_at          TIMESTAMPTZ,
  expiry_date              DATE,
  access_tier              TEXT NOT NULL DEFAULT 'STANDARD',
  notes                    TEXT,
  created_by               UUID NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_cred_type_chk CHECK (
    credential_type IN (
      'VENDOR_PORTAL', 'SERVICE_ACCOUNT', 'API_KEY',
      'SSL_CERTIFICATE', 'WIFI_CREDENTIAL', 'ADMIN_SHARED', 'OTHER'
    )
  ),
  CONSTRAINT tech_cred_tier_chk CHECK (
    access_tier IN ('STANDARD', 'ELEVATED', 'CRITICAL')
  )
);

CREATE INDEX IF NOT EXISTS tech_cred_school_type_idx
  ON tech_credential_vault (school_id, credential_type);

CREATE INDEX IF NOT EXISTS tech_cred_expiry_idx
  ON tech_credential_vault (expiry_date)
  WHERE expiry_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS tech_cred_rotation_idx
  ON tech_credential_vault (rotation_due_at)
  WHERE rotation_due_at IS NOT NULL;

COMMENT ON TABLE tech_credential_vault IS
  'SECURITY KEYSTONE per ADR-065. Stores AES-256-encrypted shared service credentials (vendor portals, service accounts, API keys, SSL certs, Wi-Fi passwords, admin shared accounts) with tiered access (STANDARD / ELEVATED / CRITICAL). The schema does not store the encryption key — the Step 6 service derives it from process.env.IT_VAULT_KEY and applies AES-256-GCM via Node crypto. Every access (view, copy, modify, create, delete) writes an immutable tech_credential_access_log row in the same tenant tx. The Step 6 CredentialVaultService.getById refuses to decrypt when actor tier < credential tier.';

COMMENT ON COLUMN tech_credential_vault.encrypted_password IS
  'AES-256-GCM ciphertext + auth tag, base64-encoded. The Step 6 service derives the key from process.env.IT_VAULT_KEY (separate from the student-data key per ADR-065). NEVER served on list endpoints. The single-row getById endpoint decrypts and returns plaintext after tier check, then writes a VIEW access_log row.';

CREATE TABLE IF NOT EXISTS tech_credential_access_log (
  id              UUID PRIMARY KEY,
  credential_id   UUID NOT NULL,
  accessed_by     UUID NOT NULL,
  access_type     TEXT NOT NULL,
  accessed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_cred_log_type_chk CHECK (
    access_type IN ('VIEW', 'COPY', 'MODIFY', 'CREATE', 'DELETE')
  ),
  CONSTRAINT tech_cred_log_cred_fk FOREIGN KEY (credential_id)
    REFERENCES tech_credential_vault(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tech_cred_log_cred_idx
  ON tech_credential_access_log (credential_id, accessed_at DESC);

CREATE INDEX IF NOT EXISTS tech_cred_log_actor_idx
  ON tech_credential_access_log (accessed_by, accessed_at DESC);

COMMENT ON TABLE tech_credential_access_log IS
  'IMMUTABLE per ADR-010 — append-only via CredentialVaultService. NO UPDATE and NO DELETE methods on the service surface. 5-value access_type CHECK (VIEW, COPY, MODIFY, CREATE, DELETE). CASCADE on parent credential — when a credential is deleted (admin-only), the audit log is dropped too. Mirrors the Cycle 8 tkt_ticket_activity and Cycle 21 fac_work_order_activity patterns. accessed_by is a soft FK to platform.platform_users per ADR-001/020.';
