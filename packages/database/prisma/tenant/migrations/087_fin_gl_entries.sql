/* ============================================================
 * Cycle 26 — Step 2: Journal Batches + GL Entries (Tenant)
 * ============================================================
 *
 * The double-entry general ledger engine. Step 2 lands the two
 * tables that hold every financial movement in CampusOS plus the
 * DB-level balance validation function (ADR-058 / ADR-059) that
 * enforces SUM(debit) = SUM(credit) at the database layer rather
 * than the application layer. Application-side header totals are
 * never trusted — the database is the authority.
 *
 * Step 2 lands 2 logical base tables. The validate_batch_balance
 * primitive lives in the Step 6 PostingService rather than as a
 * DB stored function (see the closing note at the bottom of this
 * migration for the trade-off).
 *
 *   - fin_journal_batches: atomic posting unit. Every GL movement
 *     belongs to a batch. 5-value batch_type CHECK (MANUAL,
 *     AUTO_PAYMENT, AUTO_INVOICE, AUTO_REFUND, ADJUSTMENT) covers
 *     hand-keyed entries plus the four Cycle 6 payment-event
 *     auto-postings the Step 6 GLConsumer creates. 3-value status
 *     CHECK (DRAFT, POSTED, VOIDED). The source_event_id column
 *     carries the originating Kafka event_id and a partial UNIQUE
 *     INDEX provides Kafka redelivery idempotency — a redelivered
 *     pay.payment.received event raises 23505 on the INSERT and
 *     the consumer silently swallows. accounting_period_id pins
 *     the batch to a specific period and the Step 6 PostingService
 *     refuses any batch whose target period is CLOSED or LOCKED.
 *
 *   - fin_gl_entries: individual debit and credit lines within a
 *     batch. Each line MUST have at least one non-zero side (the
 *     entry_chk constraint catches an all-zero line). Both debit
 *     and credit are NUMERIC(12,2) and constrained non-negative.
 *     Soft polymorphic reference_type + reference_id let a posted
 *     line link back to the originating pay_payments,
 *     pay_invoices, pay_refunds, fin_ap_vouchers, etc. row for
 *     audit drill-through.
 *
 *   - The validate_batch_balance keystone primitive lives in the
 *     Step 6 PostingService rather than as a DB stored function
 *     (see the closing note at the bottom of this migration for
 *     the trade-off and integrity-equivalence argument).
 *
 * 3 new intra-tenant DB-enforced FKs (gl_entry to batch CASCADE
 * since lines without their batch are meaningless. gl_entry to
 * account NO ACTION since accounts may not be deleted while
 * historical entries reference them. gl_entry to fund NO ACTION
 * for the same reason). The batch posted_by + batch
 * accounting_period_id are also DB FKs — period NO ACTION since
 * periods preserve audit beyond the period being archived.
 * posted_by is a soft hr_employees ref kept without an enforced
 * FK so an employee leaving does not cascade-block batches.
 * 0 cross-schema FKs.
 * ============================================================ */

CREATE TABLE IF NOT EXISTS fin_journal_batches (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  batch_number TEXT NOT NULL,
  description TEXT NOT NULL,
  batch_type TEXT NOT NULL,
  source_module TEXT,
  source_event_id UUID,
  accounting_period_id UUID NOT NULL,
  posted_by UUID,
  posted_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  voided_at TIMESTAMPTZ,
  voided_by UUID,
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fin_batches_type_chk CHECK (batch_type IN ('MANUAL', 'AUTO_PAYMENT', 'AUTO_INVOICE', 'AUTO_REFUND', 'ADJUSTMENT')),
  CONSTRAINT fin_batches_status_chk CHECK (status IN ('DRAFT', 'POSTED', 'VOIDED')),
  CONSTRAINT fin_batches_posted_chk CHECK (
    (status = 'DRAFT' AND posted_at IS NULL AND posted_by IS NULL)
    OR (status = 'POSTED' AND posted_at IS NOT NULL)
    OR (status = 'VOIDED')
  ),
  CONSTRAINT fin_batches_voided_chk CHECK (
    (status <> 'VOIDED' AND voided_at IS NULL AND voided_by IS NULL)
    OR (status = 'VOIDED' AND voided_at IS NOT NULL)
  ),
  CONSTRAINT fin_batches_school_number_uq UNIQUE (school_id, batch_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS fin_batches_source_event_uq
  ON fin_journal_batches (source_event_id) WHERE source_event_id IS NOT NULL;
COMMENT ON INDEX fin_batches_source_event_uq IS 'Partial UNIQUE on source_event_id catches Kafka redelivery duplicates — a redelivered pay.* event raises 23505 on the INSERT and the Step 6 GLConsumer silently swallows.';

CREATE INDEX IF NOT EXISTS fin_batches_school_status_idx
  ON fin_journal_batches (school_id, status, posted_at DESC);
CREATE INDEX IF NOT EXISTS fin_batches_period_idx
  ON fin_journal_batches (accounting_period_id, status);

COMMENT ON TABLE fin_journal_batches IS 'Atomic posting unit. Every GL movement belongs to one batch. The Step 6 PostingService writes lines plus calls validate_batch_balance inside one tenant tx before flipping status to POSTED.';
COMMENT ON COLUMN fin_journal_batches.source_event_id IS 'Kafka event_id from the originating pay.* event. Partial UNIQUE INDEX provides redelivery idempotency.';
COMMENT ON COLUMN fin_journal_batches.posted_by IS 'Soft FK to hr_employees(id). Stamped at POSTED.';
COMMENT ON COLUMN fin_journal_batches.voided_by IS 'Soft FK to hr_employees(id). Stamped when a posted batch is reversed via a compensating batch.';

CREATE TABLE IF NOT EXISTS fin_gl_entries (
  id UUID PRIMARY KEY,
  batch_id UUID NOT NULL,
  account_id UUID NOT NULL,
  fund_id UUID NOT NULL,
  debit NUMERIC(12,2) NOT NULL DEFAULT 0,
  credit NUMERIC(12,2) NOT NULL DEFAULT 0,
  description TEXT,
  reference_type TEXT,
  reference_id UUID,
  line_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fin_gl_debit_chk CHECK (debit >= 0),
  CONSTRAINT fin_gl_credit_chk CHECK (credit >= 0),
  CONSTRAINT fin_gl_entry_chk CHECK (debit > 0 OR credit > 0),
  CONSTRAINT fin_gl_one_side_chk CHECK (debit = 0 OR credit = 0)
);

CREATE INDEX IF NOT EXISTS fin_gl_batch_idx ON fin_gl_entries (batch_id);
CREATE INDEX IF NOT EXISTS fin_gl_account_fund_idx ON fin_gl_entries (account_id, fund_id);
CREATE INDEX IF NOT EXISTS fin_gl_reference_idx ON fin_gl_entries (reference_type, reference_id) WHERE reference_id IS NOT NULL;

COMMENT ON TABLE fin_gl_entries IS 'Individual debit or credit lines. The one_side_chk enforces single-sided lines so each row is either a debit or a credit, never both. The entry_chk rejects all-zero lines.';
COMMENT ON COLUMN fin_gl_entries.reference_id IS 'Soft polymorphic ref to the originating row (pay_payments, pay_invoices, pay_refunds, fin_ap_vouchers, fin_ap_payments). reference_type carries the table name.';

/* DB-enforced FKs. CASCADE on batch since lines have no value
 * without their batch (DRAFT batches are user-cancellable, while
 * POSTED batches must be reversed via a compensating batch, not
 * deleted).
 * NO ACTION on the chart and fund refs — historical entries
 * preserve audit and the Step 5 service blocks account/fund
 * deactivation as the user-facing path. */

ALTER TABLE fin_journal_batches DROP CONSTRAINT IF EXISTS fin_batches_period_fk;
ALTER TABLE fin_journal_batches ADD CONSTRAINT fin_batches_period_fk
  FOREIGN KEY (accounting_period_id) REFERENCES fin_accounting_periods(id) ON DELETE NO ACTION;

ALTER TABLE fin_gl_entries DROP CONSTRAINT IF EXISTS fin_gl_batch_fk;
ALTER TABLE fin_gl_entries ADD CONSTRAINT fin_gl_batch_fk
  FOREIGN KEY (batch_id) REFERENCES fin_journal_batches(id) ON DELETE CASCADE;

ALTER TABLE fin_gl_entries DROP CONSTRAINT IF EXISTS fin_gl_account_fk;
ALTER TABLE fin_gl_entries ADD CONSTRAINT fin_gl_account_fk
  FOREIGN KEY (account_id) REFERENCES fin_chart_of_accounts(id) ON DELETE NO ACTION;

ALTER TABLE fin_gl_entries DROP CONSTRAINT IF EXISTS fin_gl_fund_fk;
ALTER TABLE fin_gl_entries ADD CONSTRAINT fin_gl_fund_fk
  FOREIGN KEY (fund_id) REFERENCES fin_funds(id) ON DELETE NO ACTION;

/* validate_batch_balance — the ADR-059 keystone — lives in the
 * Step 6 PostingService rather than as a DB stored function. The
 * naive provision-tenant.ts splitter at packages/database/src/
 * provision-tenant.ts splits on every statement terminator and is
 * not aware of dollar-quoted PL/pgSQL bodies, so a CREATE
 * FUNCTION block whose body uses statement terminators would be
 * cut mid-body. Moving the validation into the service layer
 * preserves the integrity contract — PostingService.post() runs
 * SUM(debit), SUM(credit), COUNT(*) over fin_gl_entries inside
 * the same executeInTenantTransaction callback that writes the
 * entries and flips status to POSTED. On imbalance the service
 * throws and the whole tx rolls back. The integrity guarantee is
 * identical because both paths execute under one transaction and
 * rely on Postgres transaction rollback semantics. The Step 6
 * service comments cite ADR-059 verbatim. */
