/* P2-4a REVIEW Round 1 — pay-period lifecycle lockstep.

   Migration 111 carried status + dates CHECKs but no lockstep
   between status and the (paid_at, paid_by) / (processed_at,
   processed_by) timestamps. The reviewer flagged this as MAJOR #2:
   a buggy service path could land status='PAID' with paid_at NULL.
   This migration adds two multi-column CHECKs via the splitter-safe
   DROP IF EXISTS + ADD pattern. Idempotent across re-provisions.

   processed_chk:
     - status IN ('OPEN', 'CLOSED') -> processed_at + processed_by both NULL
     - status IN ('PROCESSING', 'PAID') -> both NOT NULL

   paid_chk:
     - status <> 'PAID' -> paid_at + paid_by both NULL
     - status = 'PAID'  -> both NOT NULL */

ALTER TABLE hr_pay_periods
  DROP CONSTRAINT IF EXISTS hr_pay_periods_processed_chk;

ALTER TABLE hr_pay_periods
  ADD CONSTRAINT hr_pay_periods_processed_chk
    CHECK (
      (
        status IN ('OPEN', 'CLOSED')
        AND processed_at IS NULL
        AND processed_by IS NULL
      )
      OR
      (
        status IN ('PROCESSING', 'PAID')
        AND processed_at IS NOT NULL
        AND processed_by IS NOT NULL
      )
    );

ALTER TABLE hr_pay_periods
  DROP CONSTRAINT IF EXISTS hr_pay_periods_paid_chk;

ALTER TABLE hr_pay_periods
  ADD CONSTRAINT hr_pay_periods_paid_chk
    CHECK (
      (
        status <> 'PAID'
        AND paid_at IS NULL
        AND paid_by IS NULL
      )
      OR
      (
        status = 'PAID'
        AND paid_at IS NOT NULL
        AND paid_by IS NOT NULL
      )
    );

COMMENT ON CONSTRAINT hr_pay_periods_processed_chk ON hr_pay_periods IS
  'Multi-column lockstep — processed_at + processed_by are populated together when status is PROCESSING or PAID. OPEN and CLOSED keep both columns NULL. Tightened in REVIEW-P2-4a Round 1.';

COMMENT ON CONSTRAINT hr_pay_periods_paid_chk ON hr_pay_periods IS
  'Multi-column lockstep — paid_at + paid_by are populated together when status is PAID. Every other status keeps both columns NULL. Tightened in REVIEW-P2-4a Round 1.';
