/* 125_pay_lunch_accounts
 *
 * Phase 2 Cycle 6 (P2-6) Step 3 — Lunch Accounts.
 *
 * Plan reference — docs/campusos-p2c6-payments-advanced.html Step 3.
 *
 * 3 new tables for the M84 .1 lunch-account surface that the cafeteria
 * POS scans against:
 *
 *   pay_lunch_accounts                       — one row per student
 *                                              UNIQUE(student_id) so a
 *                                              student carries exactly
 *                                              one lunch account.
 *                                              balance NUMERIC(8,2)
 *                                              tracks the running total
 *                                              after every transaction.
 *                                              low_balance_threshold
 *                                              configures the parent
 *                                              alert via the Step 10
 *                                              LunchAccountConsumer.
 *                                              auto_replenish_enabled
 *                                              forward-compatible flag
 *                                              for the future Stripe
 *                                              SetupIntent integration.
 *   pay_lunch_transactions                   — append-only transaction
 *                                              log. transaction_type is
 *                                              MEAL_CHARGE (cafeteria
 *                                              POS scan), DEPOSIT
 *                                              (parent tops up),
 *                                              REFUND, or ADJUSTMENT
 *                                              (admin correction).
 *                                              meal_date plus
 *                                              pos_device_id back the
 *                                              dedup contract on the
 *                                              Step 10 consumer to
 *                                              avoid double-charging
 *                                              on Kafka redelivery.
 *   pay_lunch_account_balance_transfers      — IMMUTABLE per ADR-010.
 *                                              transfer_type covers
 *                                              SIBLING_TRANSFER (e.g.
 *                                              graduating student to
 *                                              continuing sibling),
 *                                              NEXT_YEAR_ROLLOVER, or
 *                                              REFUND_TO_FAMILY (paid
 *                                              back via pay_refunds).
 *                                              No UPDATE, no DELETE
 *                                              service paths exist —
 *                                              corrections are made by
 *                                              creating an offsetting
 *                                              transfer in the other
 *                                              direction.
 *
 * Splitter rules — no semicolons inside any block comment header,
 * single-quoted string, or COMMENT ON ... text. Use commas, em
 * dashes, or "and" in narrative text instead.
 */

CREATE TABLE IF NOT EXISTS pay_lunch_accounts (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    student_id UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
    balance NUMERIC(8,2) NOT NULL DEFAULT 0,
    low_balance_threshold NUMERIC(6,2) NOT NULL DEFAULT 10.00,
    auto_replenish_enabled BOOLEAN NOT NULL DEFAULT false,
    auto_replenish_amount NUMERIC(8,2),
    auto_replenish_payment_method_id UUID,
    last_low_balance_alert_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_lunch_accounts_student_uq UNIQUE (student_id),
    CONSTRAINT pay_lunch_accounts_threshold_chk CHECK (low_balance_threshold >= 0),
    CONSTRAINT pay_lunch_accounts_replenish_chk
      CHECK (
        (auto_replenish_enabled = false AND auto_replenish_amount IS NULL)
        OR (auto_replenish_enabled = true AND auto_replenish_amount IS NOT NULL AND auto_replenish_amount > 0)
      )
);

CREATE INDEX IF NOT EXISTS pay_lunch_accounts_school_idx
  ON pay_lunch_accounts(school_id);

CREATE INDEX IF NOT EXISTS pay_lunch_accounts_low_balance_idx
  ON pay_lunch_accounts(school_id) WHERE balance <= low_balance_threshold;

COMMENT ON COLUMN pay_lunch_accounts.balance IS
  'Running balance updated atomically by LunchAccountService.deposit and the Step 10 LunchAccountConsumer when fds.meal.served lands. Schema does not enforce non-negative because admins may need to push to negative briefly during a correction.';

COMMENT ON COLUMN pay_lunch_accounts.last_low_balance_alert_at IS
  'Stamp of the last pay.lunch.low_balance Kafka emit. Throttles alerts to one per 24h so a student eating multiple meals while below threshold does not spam parents.';

COMMENT ON COLUMN pay_lunch_accounts.auto_replenish_payment_method_id IS
  'Soft FK to pay_saved_payment_methods(id) per ADR-001/020. Phase 3 ops wires the Stripe charge.';

CREATE TABLE IF NOT EXISTS pay_lunch_transactions (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    lunch_account_id UUID NOT NULL REFERENCES pay_lunch_accounts(id) ON DELETE CASCADE,
    amount NUMERIC(6,2) NOT NULL,
    transaction_type TEXT NOT NULL,
    meal_date DATE,
    pos_device_id UUID,
    pos_session_id UUID,
    source_event_id UUID,
    notes TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_lunch_tx_type_chk
      CHECK (transaction_type IN ('MEAL_CHARGE','DEPOSIT','REFUND','ADJUSTMENT')),
    CONSTRAINT pay_lunch_tx_amount_chk CHECK (amount > 0),
    CONSTRAINT pay_lunch_tx_meal_date_chk
      CHECK (
        (transaction_type = 'MEAL_CHARGE' AND meal_date IS NOT NULL)
        OR (transaction_type <> 'MEAL_CHARGE')
      )
);

CREATE INDEX IF NOT EXISTS pay_lunch_tx_account_date_idx
  ON pay_lunch_transactions(lunch_account_id, meal_date DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS pay_lunch_tx_account_created_idx
  ON pay_lunch_transactions(lunch_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS pay_lunch_tx_school_type_idx
  ON pay_lunch_transactions(school_id, transaction_type, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS pay_lunch_tx_event_dedup_uq
  ON pay_lunch_transactions(source_event_id)
  WHERE source_event_id IS NOT NULL;

COMMENT ON COLUMN pay_lunch_transactions.amount IS
  'Always positive. The transaction_type determines whether this debits or credits the parent account. MEAL_CHARGE and ADJUSTMENT (when negative) decrement balance. DEPOSIT and REFUND increment balance.';

COMMENT ON COLUMN pay_lunch_transactions.source_event_id IS
  'For MEAL_CHARGE rows created by the Step 10 LunchAccountConsumer this is the inbound fds.meal.served event_id. The partial UNIQUE index gives the consumer schema-side dedup against Kafka redelivery.';

COMMENT ON COLUMN pay_lunch_transactions.pos_device_id IS
  'Soft FK to fds_pos_devices(id) per ADR-001/020. Populated for MEAL_CHARGE rows from the cafeteria POS.';

CREATE TABLE IF NOT EXISTS pay_lunch_account_balance_transfers (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    from_account_id UUID NOT NULL REFERENCES pay_lunch_accounts(id),
    to_account_id UUID REFERENCES pay_lunch_accounts(id),
    transfer_type TEXT NOT NULL,
    amount NUMERIC(8,2) NOT NULL,
    reason TEXT NOT NULL,
    refund_id UUID REFERENCES pay_refunds(id) ON DELETE SET NULL,
    processed_by UUID NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_lunch_xfer_type_chk
      CHECK (transfer_type IN ('SIBLING_TRANSFER','NEXT_YEAR_ROLLOVER','REFUND_TO_FAMILY')),
    CONSTRAINT pay_lunch_xfer_amount_chk CHECK (amount > 0),
    CONSTRAINT pay_lunch_xfer_to_account_chk
      CHECK (
        (transfer_type IN ('SIBLING_TRANSFER','NEXT_YEAR_ROLLOVER') AND to_account_id IS NOT NULL)
        OR (transfer_type = 'REFUND_TO_FAMILY' AND to_account_id IS NULL)
      ),
    CONSTRAINT pay_lunch_xfer_distinct_chk
      CHECK (to_account_id IS NULL OR to_account_id <> from_account_id),
    CONSTRAINT pay_lunch_xfer_refund_chk
      CHECK (
        (transfer_type = 'REFUND_TO_FAMILY' AND refund_id IS NOT NULL)
        OR (transfer_type <> 'REFUND_TO_FAMILY' AND refund_id IS NULL)
      )
);

CREATE INDEX IF NOT EXISTS pay_lunch_xfer_school_processed_idx
  ON pay_lunch_account_balance_transfers(school_id, processed_at DESC);

CREATE INDEX IF NOT EXISTS pay_lunch_xfer_from_idx
  ON pay_lunch_account_balance_transfers(from_account_id, processed_at DESC);

CREATE INDEX IF NOT EXISTS pay_lunch_xfer_to_idx
  ON pay_lunch_account_balance_transfers(to_account_id, processed_at DESC) WHERE to_account_id IS NOT NULL;

COMMENT ON TABLE pay_lunch_account_balance_transfers IS
  'IMMUTABLE per ADR-010. No UPDATE and no DELETE at the service layer. Corrections are made by creating offsetting transfers in the other direction. processed_by and processed_at are mandatory on creation.';

COMMENT ON COLUMN pay_lunch_account_balance_transfers.processed_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020 — the admin who initiated the transfer. NOT NULL on creation as authorisation is a precondition.';

COMMENT ON COLUMN pay_lunch_account_balance_transfers.refund_id IS
  'For REFUND_TO_FAMILY only. FK to pay_refunds(id) — the refund record that returned the lunch account balance to the family billing account. SET NULL on refund delete which should not happen in practice given the immutable refund contract.';
