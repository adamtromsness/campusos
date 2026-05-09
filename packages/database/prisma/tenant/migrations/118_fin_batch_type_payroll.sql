/* 118_fin_batch_type_payroll
 *
 * Phase 2 Cycle 4 sub-cycle c (P2-4c) — extend the
 * fin_journal_batches.batch_type CHECK constraint with
 * 'AUTO_PAYROLL' so the GLConsumer can post payroll batches when
 * it consumes hr.payroll.processed (the new P2-4c integration
 * topic). The pre-existing CHECK from Cycle 26 migration 087
 * accepted MANUAL / AUTO_PAYMENT / AUTO_INVOICE / AUTO_REFUND /
 * ADJUSTMENT — extending with AUTO_PAYROLL is splitter-safe via
 * the standard DROP IF EXISTS + ADD pattern.
 *
 * Splitter rules — no semicolons inside any block-comment header
 * or string. The batch type list inside the CHECK uses commas
 * naturally.
 */

ALTER TABLE fin_journal_batches
  DROP CONSTRAINT IF EXISTS fin_batches_type_chk;

ALTER TABLE fin_journal_batches
  ADD CONSTRAINT fin_batches_type_chk
  CHECK (batch_type IN (
    'MANUAL',
    'AUTO_PAYMENT',
    'AUTO_INVOICE',
    'AUTO_REFUND',
    'ADJUSTMENT',
    'AUTO_PAYROLL'
  ));

COMMENT ON CONSTRAINT fin_batches_type_chk ON fin_journal_batches IS
  'P2-4c — extended with AUTO_PAYROLL so GLConsumer.hr.payroll.processed routing posts a balanced DR Salaries 5100 / CR Cash 1000 + Accrued 2100 batch.';
