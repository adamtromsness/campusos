/* P2-H3 Step 3 - rpt_gl_reconciliation read model.
 *
 * Daily reconciliation worker materialises one row per (school, run, check_type)
 * verifying every financial source row has a matching GL trail.
 *
 * Five check_type values, one per source surface where the GL trail is
 * load-bearing:
 *
 *   INVOICE_AR        every pay_invoice in non-DRAFT non-CANCELLED status
 *                     has at least one GL entry with reference_type =
 *                     pay_invoices pointing at it.
 *
 *   PAYMENT_CASH      every pay_payment in COMPLETED or REFUNDED status
 *                     has at least one GL entry with reference_type =
 *                     pay_payments pointing at it.
 *
 *   REFUND_REVERSAL   every pay_refund in COMPLETED status has at least
 *                     one GL entry with reference_type = pay_refunds
 *                     pointing at it.
 *
 *   CREDIT_NOTE       every pay_credit_note row has at least one GL
 *                     entry with reference_type = pay_credit_notes
 *                     pointing at it.
 *
 *   PAYMENT_REVERSAL  every pay_payment_reversal row has at least one
 *                     GL entry with reference_type =
 *                     pay_payment_reversals pointing at it.
 *
 * discrepancies JSONB carries the offending source-row identifiers so
 * the operations runbook can drive a remediation playbook without a
 * second query. The worker emits fin.gl_reconciliation.discrepancy via
 * the durable outbox when discrepancy_count > 0 so the alerts pipeline
 * pages SRE within the financial event escalation SLA.
 *
 * Splitter-safe additive migration - idempotent across re-provisions.
 */

CREATE TABLE IF NOT EXISTS rpt_gl_reconciliation (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  check_type TEXT NOT NULL,
  total_source_rows INT NOT NULL DEFAULT 0,
  total_matched_rows INT NOT NULL DEFAULT 0,
  discrepancy_count INT NOT NULL DEFAULT 0,
  discrepancies JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_gl_recon_check_type_chk CHECK (
    check_type IN ('INVOICE_AR','PAYMENT_CASH','REFUND_REVERSAL','CREDIT_NOTE','PAYMENT_REVERSAL')
  ),
  CONSTRAINT rpt_gl_recon_status_chk CHECK (
    status IN ('CLEAN','DISCREPANCIES_FOUND','FAILED')
  ),
  CONSTRAINT rpt_gl_recon_counts_chk CHECK (
    total_source_rows >= 0 AND total_matched_rows >= 0 AND discrepancy_count >= 0
    AND total_matched_rows <= total_source_rows
    AND discrepancy_count = total_source_rows - total_matched_rows
  )
);

CREATE INDEX IF NOT EXISTS rpt_gl_recon_school_run_idx
  ON rpt_gl_reconciliation (school_id, run_at DESC);

CREATE INDEX IF NOT EXISTS rpt_gl_recon_discrepancy_idx
  ON rpt_gl_reconciliation (school_id, status, run_at DESC)
  WHERE status = 'DISCREPANCIES_FOUND';

COMMENT ON TABLE rpt_gl_reconciliation IS 'P2-H3 Step 3 - daily GL reconciliation read model. One row per (school, run, check_type). The status column flips to DISCREPANCIES_FOUND when any source row lacks a matching GL trail, and the worker emits fin.gl_reconciliation.discrepancy via the outbox alongside the row so SRE pages within SLA. counts_chk enforces the invariant matched <= source AND discrepancy = source - matched.';
COMMENT ON COLUMN rpt_gl_reconciliation.discrepancies IS 'JSONB array of { sourceId, sourceTable, issue } tuples. Issue is one of MISSING_GL_ENTRY (no GL row references this source) or AMOUNT_MISMATCH (GL row exists but amount differs - reserved for future amount-level checks).';
