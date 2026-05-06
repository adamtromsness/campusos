/*
 * 069_fds_pos_transactions.sql — Cycle 20 Step 2.
 *
 * M63 Food Service domain 2: POS device registry, meal service session
 * lifecycle (open or close), transaction records with allergen safety
 * override tracking, and cash drawer reconciliation.
 *
 * Soft FKs to platform.iam_person and platform.platform_users per
 * ADR-001 / ADR-020. The Step 6 TransactionService runs the allergen
 * cross-check before writing trn_meal_transactions — CRITICAL matches
 * are blocked unless supervisor_override_id is supplied. The
 * multi-column override_chk on fds_meal_transactions enforces the
 * lockstep at the schema level so a future repair path cannot land a
 * row with allergen_override_required=true and a NULL supervisor.
 *
 * No semicolons inside string literals or block comments.
 */

CREATE TABLE IF NOT EXISTS fds_pos_devices (
  id              UUID PRIMARY KEY,
  school_id       UUID NOT NULL,
  device_name     TEXT NOT NULL,
  location        TEXT,
  device_type     TEXT NOT NULL DEFAULT 'CASHIER_STAFFED',
  is_active       BOOLEAN NOT NULL DEFAULT true,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_pos_type_chk CHECK (
    device_type IN ('CASHIER_STAFFED', 'SELF_SERVICE_KIOSK', 'MOBILE_CART')
  ),
  CONSTRAINT fds_pos_uq UNIQUE (school_id, device_name)
);

CREATE INDEX IF NOT EXISTS fds_pos_school_active_idx
  ON fds_pos_devices (school_id, is_active);

COMMENT ON TABLE fds_pos_devices IS
  'POS device registry. 3-value device_type CHECK covers staffed register, self-service kiosk (deferred to Cycle 20.1), and mobile cart for outdoor service. UNIQUE(school, device_name) so the device name doubles as a stable handle in audit references.';

CREATE TABLE IF NOT EXISTS fds_meal_service_sessions (
  id              UUID PRIMARY KEY,
  school_id       UUID NOT NULL,
  service_date    DATE NOT NULL,
  meal_type       TEXT NOT NULL,
  opened_by       UUID NOT NULL,
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by       UUID,
  closed_at       TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_session_meal_chk CHECK (
    meal_type IN ('BREAKFAST', 'LUNCH', 'DINNER', 'SNACK')
  ),
  CONSTRAINT fds_session_closed_chk CHECK (
    (closed_at IS NULL AND closed_by IS NULL)
    OR (closed_at IS NOT NULL AND closed_by IS NOT NULL AND closed_at >= opened_at)
  ),
  CONSTRAINT fds_session_uq UNIQUE (school_id, service_date, meal_type)
);

CREATE INDEX IF NOT EXISTS fds_session_school_date_idx
  ON fds_meal_service_sessions (school_id, service_date DESC);

COMMENT ON TABLE fds_meal_service_sessions IS
  'Per-(school, date, meal_type) meal service session. UNIQUE caps to one session per slot. Multi-column closed_chk keeps closed_at + closed_by in lockstep — a session is either OPEN (both NULL) or CLOSED (both NOT NULL with closed_at >= opened_at).';

CREATE TABLE IF NOT EXISTS fds_meal_transactions (
  id                          UUID PRIMARY KEY,
  patron_id                   UUID NOT NULL,
  patron_type                 TEXT NOT NULL DEFAULT 'STUDENT',
  session_id                  UUID NOT NULL,
  pos_device_id               UUID NOT NULL,
  items                       JSONB NOT NULL DEFAULT '[]'::jsonb,
  total                       NUMERIC(6,2) NOT NULL DEFAULT 0,
  payment_method              TEXT NOT NULL,
  allergen_override_required  BOOLEAN NOT NULL DEFAULT false,
  supervisor_override_id      UUID,
  override_reason             TEXT,
  served_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  served_by                   UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_txn_patron_type_chk CHECK (patron_type IN ('STUDENT', 'STAFF')),
  CONSTRAINT fds_txn_total_chk CHECK (total >= 0),
  CONSTRAINT fds_txn_method_chk CHECK (
    payment_method IN ('LUNCH_ACCOUNT', 'INVOICE', 'CASH', 'FREE_MEAL', 'STAFF_ACCOUNT')
  ),
  CONSTRAINT fds_txn_override_chk CHECK (
    (allergen_override_required = false AND supervisor_override_id IS NULL)
    OR (allergen_override_required = true AND supervisor_override_id IS NOT NULL)
  ),
  CONSTRAINT fds_txn_session_fk FOREIGN KEY (session_id)
    REFERENCES fds_meal_service_sessions(id) ON DELETE NO ACTION,
  CONSTRAINT fds_txn_device_fk FOREIGN KEY (pos_device_id)
    REFERENCES fds_pos_devices(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS fds_txn_patron_idx
  ON fds_meal_transactions (patron_id, served_at DESC);
CREATE INDEX IF NOT EXISTS fds_txn_session_idx
  ON fds_meal_transactions (session_id, served_at);
CREATE INDEX IF NOT EXISTS fds_txn_override_idx
  ON fds_meal_transactions (allergen_override_required, served_at DESC)
  WHERE allergen_override_required = true;

COMMENT ON TABLE fds_meal_transactions IS
  'POS TRANSACTION row with ALLERGEN SAFETY KEYSTONE. Multi-column override_chk pins allergen_override_required + supervisor_override_id all-set or all-null together. NO ACTION on session + device FKs preserves financial audit when a session or device is retired. Partition-ready RANGE(served_at) monthly. Partial INDEX on override_required=true backs the audit dashboard.';

CREATE TABLE IF NOT EXISTS fds_cash_drawer_reconciliation (
  id                          UUID PRIMARY KEY,
  session_id                  UUID NOT NULL,
  pos_device_id               UUID NOT NULL,
  opening_balance             NUMERIC(8,2) NOT NULL,
  expected_closing_balance    NUMERIC(8,2) NOT NULL,
  actual_closing_balance      NUMERIC(8,2),
  variance                    NUMERIC(8,2),
  reconciled_by               UUID,
  reconciled_at               TIMESTAMPTZ,
  status                      TEXT NOT NULL DEFAULT 'OPEN',
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_recon_status_chk CHECK (
    status IN ('OPEN', 'RECONCILED', 'VARIANCE_FLAGGED')
  ),
  CONSTRAINT fds_recon_balances_chk CHECK (
    opening_balance >= 0 AND expected_closing_balance >= 0
  ),
  CONSTRAINT fds_recon_reconciled_chk CHECK (
    (status = 'OPEN' AND reconciled_by IS NULL AND reconciled_at IS NULL)
    OR (status IN ('RECONCILED', 'VARIANCE_FLAGGED') AND reconciled_by IS NOT NULL AND reconciled_at IS NOT NULL AND actual_closing_balance IS NOT NULL)
  ),
  CONSTRAINT fds_recon_uq UNIQUE (session_id, pos_device_id),
  CONSTRAINT fds_recon_session_fk FOREIGN KEY (session_id)
    REFERENCES fds_meal_service_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fds_recon_device_fk FOREIGN KEY (pos_device_id)
    REFERENCES fds_pos_devices(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS fds_recon_status_idx
  ON fds_cash_drawer_reconciliation (status, created_at DESC);

COMMENT ON TABLE fds_cash_drawer_reconciliation IS
  'Per-(session, device) cash drawer reconciliation. 3-value status CHECK with multi-column reconciled_chk pins reconciled_by + reconciled_at + actual_closing_balance all-set when status is non-OPEN. The Step 6 ReconciliationService computes variance + flags VARIANCE_FLAGGED when the absolute variance exceeds the configured threshold (default 1.00).';
