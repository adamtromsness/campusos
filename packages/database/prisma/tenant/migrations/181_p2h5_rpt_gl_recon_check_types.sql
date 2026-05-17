/*
 * P2-H5 DEFECT 5 — extend the rpt_gl_reconciliation check_type CHECK to
 * include the two new reconciliation check types added by the hardening
 * remediation: DUPLICATE_POSTING (one source_event_id mapped to multiple
 * fin_journal_batches rows) and ORPHAN_GL_ENTRY (fin_gl_entries row with
 * reference_id that does not resolve in the named source table).
 *
 * Splitter-safe DROP IF EXISTS + ADD pattern matching the precedent set by
 * Cycle 17 sis_attendance_records_status_chk extension and Cycle 23
 * cur_curriculum_maps_status_chk. Existing rows keep working — the new
 * values are added to the union, not removed from it.
 */

ALTER TABLE rpt_gl_reconciliation
  DROP CONSTRAINT IF EXISTS rpt_gl_recon_check_type_chk;

ALTER TABLE rpt_gl_reconciliation
  ADD CONSTRAINT rpt_gl_recon_check_type_chk CHECK (
    check_type IN (
      'INVOICE_AR',
      'PAYMENT_CASH',
      'REFUND_REVERSAL',
      'CREDIT_NOTE',
      'PAYMENT_REVERSAL',
      'DUPLICATE_POSTING',
      'ORPHAN_GL_ENTRY'
    )
  );
