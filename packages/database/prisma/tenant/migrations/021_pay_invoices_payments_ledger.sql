/* 021_pay_invoices_payments_ledger.sql
 * Cycle 6 Step 4 — Payments billing engine. Invoices, line items,
 * payments with Stripe references, the immutable annually
 * RANGE-partitioned ledger, refunds, and payment plans for
 * installment billing.
 *
 * Seven logical base tables on top of Step 3 foundation
 * (pay_family_accounts, pay_family_account_students, pay_fee_categories,
 *  pay_fee_schedules, pay_stripe_accounts):
 *
 *   pay_invoices                    — per-(school, family_account) bill.
 *                                     6-state lifecycle DRAFT / SENT /
 *                                     PARTIAL / PAID / OVERDUE / CANCELLED.
 *                                     Multi-column status_chk keeps sent_at
 *                                     in lockstep with status — DRAFT is
 *                                     pre-issue (sent_at NULL), SENT and
 *                                     onwards (except CANCELLED) require
 *                                     sent_at to be populated. CANCELLED
 *                                     unconstrained because an invoice can
 *                                     be cancelled either before or after
 *                                     issue and both audit shapes are
 *                                     legitimate. total_amount NUMERIC(10,2)
 *                                     with non-negative CHECK. due_date is
 *                                     nullable for one-off / open-ended
 *                                     invoices.
 *   pay_invoice_line_items          — invoice breakdown. invoice_id CASCADE
 *                                     (line items meaningless without parent
 *                                     invoice). Optional fee_schedule_id
 *                                     no-cascade nullable so the line item
 *                                     records which fee schedule it was
 *                                     billed from — historical attribution
 *                                     even after a schedule is deactivated.
 *                                     quantity NUMERIC(6,2) > 0, unit_price
 *                                     NUMERIC(10,2) >= 0, total NUMERIC(10,2)
 *                                     >= 0. total is denormalised — service
 *                                     layer computes total = quantity *
 *                                     unit_price (or applies per-line
 *                                     discounts in a future cycle) but the
 *                                     schema keeps both rather than a
 *                                     GENERATED ALWAYS AS column so the
 *                                     formula stays in service code.
 *   pay_payments                    — payment attempts and completions.
 *                                     invoice_id and family_account_id
 *                                     no-cascade — payments preserve audit
 *                                     trail even on cancelled invoices and
 *                                     closed accounts. Cannot delete an
 *                                     invoice with payments attached
 *                                     (financial records are immutable).
 *                                     amount NUMERIC(10,2) > 0 (payments
 *                                     are always positive — a refund is a
 *                                     separate pay_refunds row pointing back
 *                                     at the original payment_id). 5-value
 *                                     payment_method enum CARD /
 *                                     BANK_TRANSFER / CASH / CHEQUE /
 *                                     WAIVER. 4-state status enum PENDING
 *                                     / COMPLETED / FAILED / REFUNDED.
 *                                     Multi-column paid_chk keeps paid_at
 *                                     in lockstep with terminal status —
 *                                     PENDING and FAILED ⇒ paid_at NULL
 *                                     (payment did not complete), COMPLETED
 *                                     and REFUNDED ⇒ paid_at NOT NULL
 *                                     (payment did complete, even if later
 *                                     refunded). stripe_payment_intent_id is
 *                                     unconstrained at the schema layer —
 *                                     stubbed in Cycle 6 — Stripe wiring is
 *                                     Phase 3 ops.
 *   pay_ledger_entries              — IMMUTABLE accounting log.
 *                                     RANGE-partitioned by created_at
 *                                     annually 2025–2030 (six partitions).
 *                                     Composite PK (id, created_at) so the
 *                                     partition column is in the unique
 *                                     constraint. 5-value entry_type CHECK
 *                                     CHARGE / PAYMENT / REFUND / CREDIT /
 *                                     ADJUSTMENT. amount NUMERIC(10,2) — by
 *                                     convention CHARGE entries are positive,
 *                                     PAYMENT entries are negative (reduce
 *                                     balance), REFUND entries are positive
 *                                     (increase balance back), CREDIT and
 *                                     ADJUSTMENT can be either sign — the
 *                                     schema does NOT enforce sign rules
 *                                     because corrections need full freedom.
 *                                     The service layer (Step 7
 *                                     LedgerService) is the authority. No
 *                                     DB trigger blocks UPDATE/DELETE per
 *                                     the plan — immutability is service
 *                                     discipline. reference_id is a soft
 *                                     polymorphic ref to the originating
 *                                     pay_invoices.id / pay_payments.id /
 *                                     pay_refunds.id depending on
 *                                     entry_type. INDEX(family_account_id,
 *                                     created_at DESC) drives the per-
 *                                     account ledger view and the
 *                                     SUM(amount) balance query (cached in
 *                                     Redis ledger:balance:account_id
 *                                     TTL=30s by Step 7). BRIN on
 *                                     created_at supports the monthly
 *                                     statement export.
 *   pay_refunds                     — refund lifecycle on top of a
 *                                     completed payment. payment_id and
 *                                     family_account_id no-cascade — same
 *                                     immutable-financial-records reason.
 *                                     amount NUMERIC(10,2) > 0. 6-value
 *                                     refund_category enum OVERPAYMENT /
 *                                     WITHDRAWAL / PROGRAMME_CANCELLED /
 *                                     ERROR_CORRECTION / GOODWILL / OTHER.
 *                                     reason TEXT NOT NULL — admin must
 *                                     justify every refund. 3-state status
 *                                     enum PENDING / COMPLETED / FAILED.
 *                                     authorised_by + authorised_at NOT
 *                                     NULL on creation — admin records who
 *                                     approved the refund up front — the
 *                                     pair has no half-state because
 *                                     authorisation is a precondition of
 *                                     creating the row.
 *   pay_payment_plans               — installment billing on a single
 *                                     invoice. invoice_id UNIQUE — one
 *                                     active plan per invoice. family
 *                                     _account_id and invoice_id no-cascade.
 *                                     installment_count INT > 0. 2-value
 *                                     frequency enum MONTHLY / QUARTERLY.
 *                                     4-state status enum ACTIVE /
 *                                     COMPLETED / DEFAULTED / CANCELLED.
 *                                     The Step 7 PaymentPlanService
 *                                     auto-generates the matching
 *                                     installment rows on plan creation
 *                                     inside one executeInTenantTransaction.
 *   pay_payment_plan_installments   — auto-generated per-installment row.
 *                                     plan_id CASCADE (installment without
 *                                     plan is meaningless). payment_id
 *                                     no-cascade nullable — once an
 *                                     installment is paid the row points at
 *                                     the pay_payments row that fulfilled
 *                                     it — deleting the payment is blocked
 *                                     by the FK so financial records stay
 *                                     consistent. installment_number INT >
 *                                     0. amount NUMERIC(10,2) >= 0. 4-state
 *                                     status enum UPCOMING / DUE / PAID /
 *                                     OVERDUE. UNIQUE(plan_id,
 *                                     installment_number) so the
 *                                     auto-generation cannot land
 *                                     duplicates.
 *
 * Twelve new intra-tenant DB-enforced FKs:
 *   pay_invoices.family_account_id                         NO ACTION
 *   pay_invoice_line_items.invoice_id                      CASCADE
 *   pay_invoice_line_items.fee_schedule_id                 NO ACTION (nullable)
 *   pay_payments.invoice_id                                NO ACTION
 *   pay_payments.family_account_id                         NO ACTION
 *   pay_ledger_entries.family_account_id                   NO ACTION (replicates to 6 partitions)
 *   pay_refunds.payment_id                                 NO ACTION
 *   pay_refunds.family_account_id                          NO ACTION
 *   pay_payment_plans.family_account_id                    NO ACTION
 *   pay_payment_plans.invoice_id                           NO ACTION
 *   pay_payment_plan_installments.plan_id                  CASCADE
 *   pay_payment_plan_installments.payment_id               NO ACTION (nullable)
 *
 * Cross-schema refs (school_id on pay_invoices, authorised_by on
 * pay_refunds) stay soft per ADR-001/020/055. No PG ENUM types — TEXT
 * plus CHECK in lockstep with the application DTOs. Block-comment
 * style and no semicolons inside any string literal or block comment
 * per the splitter trap (the splitter cuts on every semicolon
 * regardless of quoting context).
 *
 * Idempotent — safe to re-run.
 */
CREATE TABLE IF NOT EXISTS pay_invoices (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    family_account_id UUID NOT NULL REFERENCES pay_family_accounts(id),
    title TEXT NOT NULL,
    description TEXT,
    total_amount NUMERIC(10,2) NOT NULL,
    due_date DATE,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    sent_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_invoices_total_chk CHECK (total_amount >= 0),
    CONSTRAINT pay_invoices_status_chk CHECK (status IN ('DRAFT','SENT','PARTIAL','PAID','OVERDUE','CANCELLED')),
    CONSTRAINT pay_invoices_sent_chk CHECK (
        (status = 'DRAFT' AND sent_at IS NULL)
        OR
        (status IN ('SENT','PARTIAL','PAID','OVERDUE') AND sent_at IS NOT NULL)
        OR
        status = 'CANCELLED'
    )
);
CREATE INDEX IF NOT EXISTS pay_invoices_school_status_idx ON pay_invoices(school_id, status);
CREATE INDEX IF NOT EXISTS pay_invoices_account_due_idx ON pay_invoices(family_account_id, due_date);
COMMENT ON COLUMN pay_invoices.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020.';
COMMENT ON COLUMN pay_invoices.family_account_id IS 'DB-enforced FK to pay_family_accounts(id) — both intra-tenant. No cascade — financial records preserved even when an account is closed. Admin must zero out balance before closing.';
COMMENT ON COLUMN pay_invoices.status IS 'Lifecycle. DRAFT before issue (sent_at NULL). SENT once issued. PARTIAL once payments are recorded but balance non-zero. PAID when balance hits zero. OVERDUE when due_date is past and balance non-zero — flipped by a Step 7 sweep job, not by InvoiceService.send. CANCELLED is terminal — admin voids the invoice and balance stays at the ledger.';
COMMENT ON COLUMN pay_invoices.sent_at IS 'When InvoiceService.send flipped status DRAFT→SENT. Multi-column sent_chk keeps this in lockstep with status — DRAFT is sent_at NULL, non-DRAFT non-CANCELLED requires sent_at to be populated.';
COMMENT ON COLUMN pay_invoices.total_amount IS 'NUMERIC(10,2) so a single invoice can be up to 99,999,999.99. Non-negative — an invoice can be 0 (waiver applied at line-item level) but not negative.';
CREATE TABLE IF NOT EXISTS pay_invoice_line_items (
    id UUID PRIMARY KEY,
    invoice_id UUID NOT NULL REFERENCES pay_invoices(id) ON DELETE CASCADE,
    fee_schedule_id UUID REFERENCES pay_fee_schedules(id),
    description TEXT NOT NULL,
    quantity NUMERIC(6,2) NOT NULL DEFAULT 1,
    unit_price NUMERIC(10,2) NOT NULL,
    total NUMERIC(10,2) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_invoice_line_items_quantity_chk CHECK (quantity > 0),
    CONSTRAINT pay_invoice_line_items_unit_price_chk CHECK (unit_price >= 0),
    CONSTRAINT pay_invoice_line_items_total_chk CHECK (total >= 0)
);
CREATE INDEX IF NOT EXISTS pay_invoice_line_items_invoice_idx ON pay_invoice_line_items(invoice_id);
CREATE INDEX IF NOT EXISTS pay_invoice_line_items_fee_schedule_idx ON pay_invoice_line_items(fee_schedule_id) WHERE fee_schedule_id IS NOT NULL;
COMMENT ON COLUMN pay_invoice_line_items.fee_schedule_id IS 'DB-enforced FK to pay_fee_schedules(id) — both intra-tenant. Nullable for ad-hoc charges (e.g. damage fees) that do not match a fee schedule. No cascade so a deactivated schedule still has its history preserved on existing invoices.';
COMMENT ON COLUMN pay_invoice_line_items.total IS 'Denormalised line total. Service layer computes total = quantity * unit_price (or applies per-line discounts in a future cycle). Kept rather than a GENERATED ALWAYS AS column so the formula stays owned by service code.';
CREATE TABLE IF NOT EXISTS pay_payments (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    invoice_id UUID NOT NULL REFERENCES pay_invoices(id),
    family_account_id UUID NOT NULL REFERENCES pay_family_accounts(id),
    amount NUMERIC(10,2) NOT NULL,
    payment_method TEXT NOT NULL,
    stripe_payment_intent_id TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    paid_at TIMESTAMPTZ,
    receipt_s3_key TEXT,
    notes TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_payments_amount_chk CHECK (amount > 0),
    CONSTRAINT pay_payments_method_chk CHECK (payment_method IN ('CARD','BANK_TRANSFER','CASH','CHEQUE','WAIVER')),
    CONSTRAINT pay_payments_status_chk CHECK (status IN ('PENDING','COMPLETED','FAILED','REFUNDED')),
    CONSTRAINT pay_payments_paid_chk CHECK (
        (status IN ('PENDING','FAILED') AND paid_at IS NULL)
        OR
        (status IN ('COMPLETED','REFUNDED') AND paid_at IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS pay_payments_account_paid_idx ON pay_payments(family_account_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS pay_payments_invoice_idx ON pay_payments(invoice_id);
CREATE INDEX IF NOT EXISTS pay_payments_school_status_idx ON pay_payments(school_id, status);
CREATE INDEX IF NOT EXISTS pay_payments_stripe_intent_idx ON pay_payments(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
COMMENT ON COLUMN pay_payments.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020. Denormalised from the invoice for the per-school payments report query.';
COMMENT ON COLUMN pay_payments.invoice_id IS 'DB-enforced FK to pay_invoices(id) — both intra-tenant. No cascade — payments preserve audit trail even when an invoice is cancelled. Cannot delete an invoice with payments attached (financial records are immutable).';
COMMENT ON COLUMN pay_payments.family_account_id IS 'DB-enforced FK to pay_family_accounts(id) — both intra-tenant. No cascade — same immutable-financial-records reason. Denormalised from the invoice so the per-account payments timeline does not need a join.';
COMMENT ON COLUMN pay_payments.amount IS 'Always positive. A refund is a separate pay_refunds row pointing back at the original payment_id, not a negative payment row.';
COMMENT ON COLUMN pay_payments.payment_method IS '5-value enum. CARD covers Stripe-processed credit/debit. BANK_TRANSFER covers ACH / wire transfers. CASH and CHEQUE are admin-recorded offline payments. WAIVER is the discount mechanism for Cycle 6 — used in lieu of pay_discount_rules until that table ships.';
COMMENT ON COLUMN pay_payments.status IS 'Lifecycle. PENDING after creation, awaiting Stripe confirmation. COMPLETED on success. FAILED on Stripe decline. REFUNDED once a pay_refunds row clears the payment back. Multi-column paid_chk keeps paid_at populated only for terminal-success states (COMPLETED, REFUNDED).';
COMMENT ON COLUMN pay_payments.stripe_payment_intent_id IS 'Stripe PaymentIntent id (pi_...) when payment_method=CARD. NULL for offline methods. Stubbed in Cycle 6 — Step 7 PaymentService accepts the value but does not call Stripe. Real Stripe wiring is Phase 3 ops.';
COMMENT ON COLUMN pay_payments.created_by IS 'Soft FK to platform.platform_users(id) — the auth account that recorded the payment. NULL for parent-self-service Stripe payments where the payment originates from the parent action — populated for admin-recorded offline payments.';
CREATE TABLE IF NOT EXISTS pay_ledger_entries (
    id UUID NOT NULL,
    family_account_id UUID NOT NULL REFERENCES pay_family_accounts(id),
    entry_type TEXT NOT NULL,
    amount NUMERIC(10,2) NOT NULL,
    reference_id UUID,
    description TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_ledger_entries_pk PRIMARY KEY (id, created_at),
    CONSTRAINT pay_ledger_entries_type_chk CHECK (entry_type IN ('CHARGE','PAYMENT','REFUND','CREDIT','ADJUSTMENT'))
) PARTITION BY RANGE (created_at);
CREATE TABLE IF NOT EXISTS pay_ledger_entries_2025 PARTITION OF pay_ledger_entries FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE IF NOT EXISTS pay_ledger_entries_2026 PARTITION OF pay_ledger_entries FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS pay_ledger_entries_2027 PARTITION OF pay_ledger_entries FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');
CREATE TABLE IF NOT EXISTS pay_ledger_entries_2028 PARTITION OF pay_ledger_entries FOR VALUES FROM ('2028-01-01') TO ('2029-01-01');
CREATE TABLE IF NOT EXISTS pay_ledger_entries_2029 PARTITION OF pay_ledger_entries FOR VALUES FROM ('2029-01-01') TO ('2030-01-01');
CREATE TABLE IF NOT EXISTS pay_ledger_entries_2030 PARTITION OF pay_ledger_entries FOR VALUES FROM ('2030-01-01') TO ('2031-01-01');
CREATE INDEX IF NOT EXISTS pay_ledger_entries_account_created_idx ON pay_ledger_entries(family_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pay_ledger_entries_reference_idx ON pay_ledger_entries(reference_id) WHERE reference_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pay_ledger_entries_created_brin_idx ON pay_ledger_entries USING BRIN (created_at);
COMMENT ON COLUMN pay_ledger_entries.family_account_id IS 'DB-enforced FK to pay_family_accounts(id) — both intra-tenant. PostgreSQL replicates this constraint onto each of the 6 annual partitions (one pg_constraint row per partition plus the parent — 7 total, expected). No cascade — the ledger is immutable so an account with ledger entries cannot be hard-deleted.';
COMMENT ON COLUMN pay_ledger_entries.entry_type IS '5-value enum. CHARGE entries are positive by convention (invoice issued). PAYMENT entries are negative (reduce balance). REFUND entries are positive (increase balance back). CREDIT and ADJUSTMENT can be either sign — manual corrections by admin. Sign is service-side discipline only — the schema allows any sign so corrections have full freedom.';
COMMENT ON COLUMN pay_ledger_entries.amount IS 'Signed NUMERIC(10,2). Balance for an account is SUM(amount) WHERE family_account_id=$1. Cached in Redis ledger:balance:account_id with 30s TTL by Step 7 LedgerService.';
COMMENT ON COLUMN pay_ledger_entries.reference_id IS 'Soft polymorphic UUID. CHARGE points at pay_invoices.id. PAYMENT points at pay_payments.id. REFUND points at pay_refunds.id. CREDIT and ADJUSTMENT may point at anything or nothing depending on the correction.';
COMMENT ON COLUMN pay_ledger_entries.created_by IS 'Soft FK to platform.platform_users(id) — the auth account that triggered the entry. Populated for admin-initiated CREDIT and ADJUSTMENT entries — for CHARGE / PAYMENT / REFUND auto-derived entries the service layer fills in the originating user when available, NULL for system-generated entries (e.g. invoice send by background job).';
CREATE TABLE IF NOT EXISTS pay_refunds (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    payment_id UUID NOT NULL REFERENCES pay_payments(id),
    family_account_id UUID NOT NULL REFERENCES pay_family_accounts(id),
    amount NUMERIC(10,2) NOT NULL,
    refund_category TEXT NOT NULL,
    reason TEXT NOT NULL,
    stripe_refund_id TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    authorised_by UUID NOT NULL,
    authorised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_refunds_amount_chk CHECK (amount > 0),
    CONSTRAINT pay_refunds_category_chk CHECK (refund_category IN ('OVERPAYMENT','WITHDRAWAL','PROGRAMME_CANCELLED','ERROR_CORRECTION','GOODWILL','OTHER')),
    CONSTRAINT pay_refunds_status_chk CHECK (status IN ('PENDING','COMPLETED','FAILED')),
    CONSTRAINT pay_refunds_completed_chk CHECK (
        (status IN ('PENDING','FAILED') AND completed_at IS NULL)
        OR
        (status = 'COMPLETED' AND completed_at IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS pay_refunds_account_created_idx ON pay_refunds(family_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pay_refunds_payment_idx ON pay_refunds(payment_id);
CREATE INDEX IF NOT EXISTS pay_refunds_school_status_idx ON pay_refunds(school_id, status);
COMMENT ON COLUMN pay_refunds.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020.';
COMMENT ON COLUMN pay_refunds.payment_id IS 'DB-enforced FK to pay_payments(id) — both intra-tenant. No cascade — refunds preserve audit trail even when the original payment is voided. Cannot delete a payment with refunds attached.';
COMMENT ON COLUMN pay_refunds.family_account_id IS 'DB-enforced FK to pay_family_accounts(id) — both intra-tenant. No cascade — same immutable-financial-records reason. Denormalised from the payment so the per-account refunds timeline does not need a join.';
COMMENT ON COLUMN pay_refunds.amount IS 'Always positive. The ledger derives the sign — REFUND entry amount is positive (increases balance back).';
COMMENT ON COLUMN pay_refunds.refund_category IS '6-value enum. OVERPAYMENT — accidental excess payment. WITHDRAWAL — student withdrew, prorated tuition. PROGRAMME_CANCELLED — school cancelled the programme. ERROR_CORRECTION — admin error. GOODWILL — discretionary. OTHER — catch-all with detail in reason.';
COMMENT ON COLUMN pay_refunds.reason IS 'Free-text justification, NOT NULL — admin must justify every refund. Surfaces on the refund audit log.';
COMMENT ON COLUMN pay_refunds.authorised_by IS 'Soft FK to platform.platform_users(id) — the auth account that approved the refund. NOT NULL because authorisation is a precondition of creating the row (no admin = no refund). Together with authorised_at this is the audit pair recorded at creation time.';
COMMENT ON COLUMN pay_refunds.completed_at IS 'When status flipped to COMPLETED (Stripe refund succeeded for CARD payments, or admin marked the offline refund cleared). Multi-column completed_chk keeps this in lockstep with status — only COMPLETED requires the timestamp.';
CREATE TABLE IF NOT EXISTS pay_payment_plans (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    family_account_id UUID NOT NULL REFERENCES pay_family_accounts(id),
    invoice_id UUID NOT NULL REFERENCES pay_invoices(id),
    total_amount NUMERIC(10,2) NOT NULL,
    installment_count INT NOT NULL,
    frequency TEXT NOT NULL,
    start_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_payment_plans_invoice_id_key UNIQUE (invoice_id),
    CONSTRAINT pay_payment_plans_total_chk CHECK (total_amount >= 0),
    CONSTRAINT pay_payment_plans_count_chk CHECK (installment_count > 0),
    CONSTRAINT pay_payment_plans_frequency_chk CHECK (frequency IN ('MONTHLY','QUARTERLY')),
    CONSTRAINT pay_payment_plans_status_chk CHECK (status IN ('ACTIVE','COMPLETED','DEFAULTED','CANCELLED'))
);
CREATE INDEX IF NOT EXISTS pay_payment_plans_account_idx ON pay_payment_plans(family_account_id);
CREATE INDEX IF NOT EXISTS pay_payment_plans_school_status_idx ON pay_payment_plans(school_id, status);
COMMENT ON COLUMN pay_payment_plans.school_id IS 'Soft FK to platform.schools(id) per ADR-001/020. Denormalised from the family account.';
COMMENT ON COLUMN pay_payment_plans.invoice_id IS 'DB-enforced FK to pay_invoices(id) — both intra-tenant. UNIQUE — at most one active plan per invoice. No cascade — plan references the master invoice and the financial record is immutable.';
COMMENT ON COLUMN pay_payment_plans.frequency IS '2-value enum MONTHLY / QUARTERLY. The Step 7 PaymentPlanService computes installment due_dates as start_date + n * (1 month or 3 months) for n in 0..installment_count-1.';
COMMENT ON COLUMN pay_payment_plans.status IS 'Lifecycle. ACTIVE while installments are in flight. COMPLETED once every installment is PAID. DEFAULTED once an installment is past due_date by more than the school grace period (Step 7 sweep job). CANCELLED when admin tears down the plan and reverts to a single-payment invoice.';
CREATE TABLE IF NOT EXISTS pay_payment_plan_installments (
    id UUID PRIMARY KEY,
    plan_id UUID NOT NULL REFERENCES pay_payment_plans(id) ON DELETE CASCADE,
    installment_number INT NOT NULL,
    amount NUMERIC(10,2) NOT NULL,
    due_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'UPCOMING',
    payment_id UUID REFERENCES pay_payments(id),
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pay_payment_plan_installments_plan_number_uq UNIQUE (plan_id, installment_number),
    CONSTRAINT pay_payment_plan_installments_number_chk CHECK (installment_number > 0),
    CONSTRAINT pay_payment_plan_installments_amount_chk CHECK (amount >= 0),
    CONSTRAINT pay_payment_plan_installments_status_chk CHECK (status IN ('UPCOMING','DUE','PAID','OVERDUE')),
    CONSTRAINT pay_payment_plan_installments_paid_chk CHECK (
        (status = 'PAID' AND payment_id IS NOT NULL AND paid_at IS NOT NULL)
        OR
        (status <> 'PAID' AND paid_at IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS pay_payment_plan_installments_due_idx ON pay_payment_plan_installments(due_date, status);
CREATE INDEX IF NOT EXISTS pay_payment_plan_installments_plan_idx ON pay_payment_plan_installments(plan_id);
CREATE INDEX IF NOT EXISTS pay_payment_plan_installments_payment_idx ON pay_payment_plan_installments(payment_id) WHERE payment_id IS NOT NULL;
COMMENT ON COLUMN pay_payment_plan_installments.plan_id IS 'DB-enforced FK to pay_payment_plans(id) — both intra-tenant. CASCADE — installments without their parent plan are meaningless.';
COMMENT ON COLUMN pay_payment_plan_installments.payment_id IS 'DB-enforced FK to pay_payments(id) — both intra-tenant. Nullable — populated only when an installment is PAID. No cascade — deleting a payment that fulfilled an installment is blocked, the installment row holds an audit reference back to the originating payment.';
COMMENT ON COLUMN pay_payment_plan_installments.status IS 'Lifecycle. UPCOMING is the default for installments whose due_date is in the future. DUE on the due_date. PAID when payment_id and paid_at are populated. OVERDUE on the day after due_date passes without payment. The Step 7 sweep job moves UPCOMING→DUE→OVERDUE and payment apply moves any state→PAID. Multi-column paid_chk keeps (status, payment_id, paid_at) consistent — PAID requires both populated, every other state requires paid_at NULL but allows payment_id NULL because the row may not yet be associated with a payment.';
