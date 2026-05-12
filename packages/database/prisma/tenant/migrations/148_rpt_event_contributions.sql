/*
  P2-15 REVIEW Round 1 BLOCKING 1 — per-event contribution ledger.

  The P2-15a + P2-15b workers all use additive ON CONFLICT DO UPDATE on
  their rpt_* targets. The outer processWithIdempotency() helper claims
  AFTER the handler succeeds (REVIEW-CYCLE2 BLOCKING 2 claim-after-success
  pattern), which is safe for non-additive consumers but is NOT safe for
  additive UPSERTs:

    1. Kafka event arrives.
    2. Handler runs the additive INSERT ... ON CONFLICT DO UPDATE
       (counters move).
    3. Process crashes BEFORE the post-handler idempotency.claim()
       call commits to platform.platform_event_consumer_idempotency.
    4. Kafka redelivers the same event.
    5. Outer claim check (isClaimed) returns false because the prior
       claim never landed.
    6. Handler re-applies the same additive UPSERT → double-count.

  The fix is a tenant-local contribution ledger that's atomic with the
  read-model UPSERT. Each worker wraps its UPSERT in a tenant tx, runs
  an INSERT … ON CONFLICT DO NOTHING into rpt_event_contributions first,
  and short-circuits if the claim insert returns 0 rows. Both rows
  commit together or neither does, so redelivery after partial failure
  is a no-op.

  Schema:
    consumer_group   — which worker group applied the contribution
    source_event_id  — the Kafka envelope.event_id
    target_table     — the rpt_* table the worker UPSERTed (one worker
                       can write to N tables, so a single event_id
                       maps to N contribution rows, one per target).
    applied_at       — when the worker actually committed.

  UNIQUE(consumer_group, source_event_id, target_table) is the gate.
  When a worker writes to multiple rpt_* tables from a single event
  (AthleticsReadModelWorker, FoodServiceReadModelWorker), it inserts
  one contribution row per target table.

  Splitter discipline: every comment is a block comment with no
  in-string semicolons.
*/

CREATE TABLE IF NOT EXISTS rpt_event_contributions (
  consumer_group TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  target_table TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_event_contributions_uq
  ON rpt_event_contributions (consumer_group, source_event_id, target_table);

CREATE INDEX IF NOT EXISTS rpt_event_contributions_applied_at_idx
  ON rpt_event_contributions (applied_at DESC);

COMMENT ON TABLE rpt_event_contributions IS
  'P2-15 read-model contribution ledger. Each row records a single source-event_id contributing to a single rpt_* target table. Workers INSERT … ON CONFLICT DO NOTHING into this table inside the same tenant tx as the read-model UPSERT, so redelivery after partial failure is a guaranteed no-op. The (consumer_group, source_event_id, target_table) UNIQUE constraint is the atomic gate.';

COMMENT ON COLUMN rpt_event_contributions.target_table IS
  'Name of the rpt_* table the worker UPSERTed against. A single event_id can produce N rows when a worker writes to multiple tables (AthleticsReadModelWorker writes rpt_game_results + rpt_ath_season_summary from one ath.game.completed event — FoodServiceReadModelWorker writes rpt_fds_meal_counts + rpt_fds_nslp_summary from one fds.meal.served event).';
