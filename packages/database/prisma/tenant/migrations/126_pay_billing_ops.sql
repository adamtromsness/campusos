/* 126_pay_billing_ops
 *
 * Phase 2 Cycle 6 (P2-6) Step 4 — Billing Operations.
 *
 * Plan reference — docs/campusos-p2c6-payments-advanced.html Step 4.
 *
 * 5 new tables for the M84 .1 billing-ops surface (credit notes,
 * payment reversals, allocations, late fees, saved payment methods).
 * The Cycle 6 pay_payment_plans table already exists with a per-
 * installment child table so we do not recreate it here. The plan
 * count of 6 includes that existing table for narrative continuity.
 *
 *   pay_credit_notes                — IMMUTABLE per ADR-010. School
 *                                     issues a credit against an
 *                                     invoice line item or against the
 *                                     full invoice (line_item_id NULL).
 *                                     reason is mandatory. CreditNote
 *                                     Service is the sole writer and
 *                                     records a CREDIT pay_ledger
 *                                     _entries row inside the same
 *                                     tenant tx as the INSERT. Then
 *                                     emits pay.credit_note.issued
 *                                     for the Cycle 26 GLConsumer.
 *                                     No UPDATE, no DELETE service
 *                                     paths exist — corrections are
 *                                     made by issuing offsetting
 *                                     credit notes or refunds.
 *   pay_payment_reversals           — IMMUTABLE per ADR-010. Captures
 *                                     a bounced cheque, recalled
 *                                     transfer, chargeback, or
 *                                     duplicate. UNIQUE(payment_id)
 *                                     so a payment cannot be reversed
 *                                     twice. ReversalService is the
 *                                     sole writer and atomically:
 *                                       - flips pay_payments.status to
 *                                         FAILED inside the same tx,
 *                                       - reinstates the parent
 *                                         pay_invoices.status to its
 *                                         pre-payment state (SENT or
 *                                         OVERDUE),
 *                                       - writes an offsetting
 *                                         pay_ledger_entries CHARGE
 *                                         row to nullify the prior
 *                                         PAYMENT credit.
 *                                     Then emits pay.payment.reversed.
 *   pay_payment_allocations         — links a single payment to one or
 *                                     more invoices when a parent pays
 *                                     multiple invoices in one
 *                                     transaction. UNIQUE(payment_id,
 *                                     invoice_id) so a payment cannot
 *                                     allocate to the same invoice
 *                                     twice. PaymentAllocationService
 *                                     validates SUM(allocated_amount)
 *                                     equals payment.amount inside the
 *                                     creation tx.
 *   pay_late_payment_policies       — per-school configuration for the
 *                                     LateFeesWorker. UNIQUE(school_id)
 *                                     so a school carries exactly one
 *                                     active policy. fee_type FIXED is
 *                                     a flat dollar amount, fee_type
 *                                     PERCENTAGE_MONTHLY is a monthly
 *                                     percentage (the worker computes
 *                                     elapsed months past the grace
 *                                     period). max_late_fee_amount is
 *                                     the cap.
 *   pay_saved_payment_methods       — Stripe payment method tokens
 *                                     associated with a family
 *                                     account. card_last_four and
 *                                     card_brand are the only card
 *                                     details ever stored — full card
 *                                     numbers never touch our DB.
 *                                     One default per family account
 *                                     enforced by a partial UNIQUE.
 *
 * Splitter rules — no semicolons inside any block comment header,
 * single-quoted string, or COMMENT ON ... text. Use commas, em
 * dashes, or "and" in narrative text instead.
 */

CREATE TABLE IF NOT EXISTS pay_credit_notes (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    invoice_id UUID NOT NULL REFERENCES pay_invoices(id),
    line_item_id UUID REFERENCES pay_invoice_line_items(id),
    family_account_id UUID NOT NULL REFERENCES pay_family_accounts(id),
    credit_amount NUMERIC(10,2) NOT NULL,
    credit_category TEXT NOT NULL DEFAULT 'GOODWILL',
    reason TEXT NOT NULL,
    ledger_entry_id UUID,
    issued_by UUID NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_credit_notes_amount_chk CHECK (credit_amount > 0),
    CONSTRAINT pay_credit_notes_category_chk
      CHECK (credit_category IN ('GOODWILL','BILLING_ERROR','PROGRAMME_CANCELLED','OVERPAYMENT','OTHER')),
    CONSTRAINT pay_credit_notes_reason_chk CHECK (length(trim(reason)) > 0)
);

CREATE INDEX IF NOT EXISTS pay_credit_notes_school_issued_idx
  ON pay_credit_notes(school_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS pay_credit_notes_invoice_idx
  ON pay_credit_notes(invoice_id);

CREATE INDEX IF NOT EXISTS pay_credit_notes_family_idx
  ON pay_credit_notes(family_account_id, issued_at DESC);

COMMENT ON TABLE pay_credit_notes IS
  'IMMUTABLE per ADR-010. Service layer never UPDATEs or DELETEs. Corrections are made by creating new offsetting credit notes or refunds.';

COMMENT ON COLUMN pay_credit_notes.line_item_id IS
  'Optional FK to pay_invoice_line_items(id). NULL means the credit applies to the full invoice rather than a specific line item.';

COMMENT ON COLUMN pay_credit_notes.ledger_entry_id IS
  'Soft FK to pay_ledger_entries(id) per ADR-001/020 — the CREDIT row that CreditNoteService wrote in the same tenant tx as the INSERT here. Read-side joins use this.';

COMMENT ON COLUMN pay_credit_notes.issued_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020 — the admin who issued the credit. NOT NULL on creation as authorisation is a precondition.';

CREATE TABLE IF NOT EXISTS pay_payment_reversals (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    payment_id UUID NOT NULL REFERENCES pay_payments(id),
    family_account_id UUID NOT NULL REFERENCES pay_family_accounts(id),
    invoice_id UUID NOT NULL REFERENCES pay_invoices(id),
    reversal_type TEXT NOT NULL,
    reversal_reason TEXT NOT NULL,
    bank_reference TEXT,
    reversed_amount NUMERIC(10,2) NOT NULL,
    ledger_entry_id UUID,
    reversed_by UUID NOT NULL,
    reversed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_payment_reversals_payment_uq UNIQUE (payment_id),
    CONSTRAINT pay_payment_reversals_amount_chk CHECK (reversed_amount > 0),
    CONSTRAINT pay_payment_reversals_type_chk
      CHECK (reversal_type IN ('BOUNCED_CHEQUE','RECALLED_TRANSFER','CHARGEBACK','DUPLICATE_PAYMENT','OTHER')),
    CONSTRAINT pay_payment_reversals_reason_chk CHECK (length(trim(reversal_reason)) > 0)
);

CREATE INDEX IF NOT EXISTS pay_payment_reversals_school_reversed_idx
  ON pay_payment_reversals(school_id, reversed_at DESC);

CREATE INDEX IF NOT EXISTS pay_payment_reversals_invoice_idx
  ON pay_payment_reversals(invoice_id);

CREATE INDEX IF NOT EXISTS pay_payment_reversals_family_idx
  ON pay_payment_reversals(family_account_id, reversed_at DESC);

COMMENT ON TABLE pay_payment_reversals IS
  'IMMUTABLE per ADR-010. Service layer never UPDATEs or DELETEs. UNIQUE(payment_id) so a payment cannot be reversed twice. To re-record a payment that was wrongly reversed, the service path is to insert a new pay_payments row (not modify this one).';

COMMENT ON COLUMN pay_payment_reversals.ledger_entry_id IS
  'Soft FK to pay_ledger_entries(id) per ADR-001/020 — the CHARGE row that ReversalService wrote in the same tenant tx as the INSERT to nullify the original PAYMENT credit.';

COMMENT ON COLUMN pay_payment_reversals.reversed_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020 — the admin who recorded the reversal. NOT NULL on creation.';

CREATE TABLE IF NOT EXISTS pay_payment_allocations (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    payment_id UUID NOT NULL REFERENCES pay_payments(id) ON DELETE CASCADE,
    invoice_id UUID NOT NULL REFERENCES pay_invoices(id),
    allocated_amount NUMERIC(10,2) NOT NULL,
    allocated_by UUID,
    allocated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_payment_alloc_pay_inv_uq UNIQUE (payment_id, invoice_id),
    CONSTRAINT pay_payment_alloc_amount_chk CHECK (allocated_amount > 0)
);

CREATE INDEX IF NOT EXISTS pay_payment_alloc_payment_idx
  ON pay_payment_allocations(payment_id);

CREATE INDEX IF NOT EXISTS pay_payment_alloc_invoice_idx
  ON pay_payment_allocations(invoice_id);

COMMENT ON COLUMN pay_payment_allocations.allocated_amount IS
  'PaymentAllocationService validates SUM(allocated_amount) for a given payment_id equals pay_payments.amount inside the creation tx. The schema stores the raw allocations and the SUM constraint is enforced application-side.';

CREATE TABLE IF NOT EXISTS pay_late_payment_policies (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT false,
    grace_period_days INT NOT NULL DEFAULT 7,
    fee_type TEXT NOT NULL,
    fee_amount NUMERIC(8,2),
    fee_percentage NUMERIC(5,4),
    max_late_fee_amount NUMERIC(8,2),
    applies_to_fee_category_id UUID REFERENCES pay_fee_categories(id),
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_late_policies_school_uq UNIQUE (school_id),
    CONSTRAINT pay_late_policies_fee_type_chk CHECK (fee_type IN ('FIXED','PERCENTAGE_MONTHLY')),
    CONSTRAINT pay_late_policies_grace_chk CHECK (grace_period_days >= 0),
    CONSTRAINT pay_late_policies_amount_chk
      CHECK (
        (fee_type = 'FIXED' AND fee_amount IS NOT NULL AND fee_amount >= 0 AND fee_percentage IS NULL)
        OR (fee_type = 'PERCENTAGE_MONTHLY' AND fee_percentage IS NOT NULL AND fee_percentage >= 0 AND fee_amount IS NULL)
      ),
    CONSTRAINT pay_late_policies_max_chk CHECK (max_late_fee_amount IS NULL OR max_late_fee_amount >= 0)
);

CREATE INDEX IF NOT EXISTS pay_late_policies_school_active_idx
  ON pay_late_payment_policies(school_id) WHERE is_active = true;

COMMENT ON COLUMN pay_late_payment_policies.fee_percentage IS
  'For PERCENTAGE_MONTHLY only. Stored as a decimal — 0.0150 means 1.5 percent per month. The LateFeesWorker computes the actual fee as max(min(elapsed_months times fee_percentage times balance_due, max_late_fee_amount), 0).';

CREATE TABLE IF NOT EXISTS pay_saved_payment_methods (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    family_account_id UUID NOT NULL REFERENCES pay_family_accounts(id) ON DELETE CASCADE,
    stripe_payment_method_id TEXT NOT NULL,
    method_type TEXT NOT NULL DEFAULT 'CARD',
    card_last_four TEXT,
    card_brand TEXT,
    card_exp_month INT,
    card_exp_year INT,
    bank_last_four TEXT,
    is_default BOOLEAN NOT NULL DEFAULT false,
    added_by UUID,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    removed_at TIMESTAMPTZ,
    CONSTRAINT pay_saved_pm_method_type_chk CHECK (method_type IN ('CARD','BANK_ACCOUNT')),
    CONSTRAINT pay_saved_pm_card_last_four_chk
      CHECK (card_last_four IS NULL OR length(card_last_four) = 4),
    CONSTRAINT pay_saved_pm_card_exp_month_chk
      CHECK (card_exp_month IS NULL OR (card_exp_month BETWEEN 1 AND 12))
);

CREATE INDEX IF NOT EXISTS pay_saved_pm_family_idx
  ON pay_saved_payment_methods(family_account_id) WHERE removed_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS pay_saved_pm_family_default_uq
  ON pay_saved_payment_methods(family_account_id)
  WHERE is_default = true AND removed_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS pay_saved_pm_stripe_id_uq
  ON pay_saved_payment_methods(school_id, stripe_payment_method_id)
  WHERE removed_at IS NULL;

COMMENT ON TABLE pay_saved_payment_methods IS
  'Token-only — stripe_payment_method_id is the Stripe pm_ token. card_last_four and card_brand are the only card details ever stored. Full card numbers, CVCs, and PINs are never persisted by CampusOS — Stripe holds the sensitive data.';

COMMENT ON COLUMN pay_saved_payment_methods.removed_at IS
  'Soft delete. The pay_saved_pm_family_default_uq partial UNIQUE includes WHERE removed_at IS NULL so a family can re-add a previously removed card without conflict.';
