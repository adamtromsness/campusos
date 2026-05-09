/* P2C3 REVIEW-P2C3 BLOCKING #3 closeout migration.

   The original migration 109 only enforced CANCELLED requires
   cancelled_at NOT NULL but allowed cancellation_reason to stay
   NULL or blank. The handoff invariant says CANCELLED requires
   a non-empty cancellation reason, and the service-layer fix
   already throws a 400 on missing reason. This migration tightens
   the schema-side CHECK so a direct INSERT path (seeds, manual
   ops, future bulk-import) cannot land a cancelled-without-reason
   row either.

   Splitter-safe DROP + ADD pattern. Idempotent across re-provisions. */

ALTER TABLE hlth_telehealth_sessions
  DROP CONSTRAINT IF EXISTS hlth_th_sessions_cancelled_chk;

ALTER TABLE hlth_telehealth_sessions
  ADD CONSTRAINT hlth_th_sessions_cancelled_chk
    CHECK (
      (
        status <> 'CANCELLED'
        AND cancelled_at IS NULL
        AND cancellation_reason IS NULL
      )
      OR
      (
        status = 'CANCELLED'
        AND cancelled_at IS NOT NULL
        AND cancellation_reason IS NOT NULL
        AND length(trim(cancellation_reason)) > 0
      )
    );

COMMENT ON CONSTRAINT hlth_th_sessions_cancelled_chk
  ON hlth_telehealth_sessions IS
  'CANCELLED requires both cancelled_at and a non-empty cancellation_reason. Tightened in P2C3 review fixes — service layer surfaces a friendly 400 before the DB CHECK fires.';
