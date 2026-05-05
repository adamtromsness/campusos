/* 051_msg_thread_stats.sql
 * Cycle 14 Step 1 — M40 Communications. Per-thread denormalised
 * summary table that lets the inbox render last_message_at and
 * last_message_preview without scanning the partitioned
 * msg_messages table at read time. Updated by the Step 4
 * ThreadStatsConsumer on every msg.message.posted Kafka event.
 *
 * Cycle 3 already shipped six of the seven tables in the Cycle 14
 * Step 1 plan list (msg_thread_types, msg_threads,
 * msg_thread_participants, msg_messages, msg_message_reads,
 * msg_message_attachments). This migration adds the seventh
 * (msg_thread_stats) and is purely additive.
 *
 * Soft refs per ADR-001 / ADR-020. thread_id refers to
 * msg_threads(id) — no DB FK because msg_threads is HASH
 * partitioned on school_id and a soft composite FK is awkward.
 * The consumer plus the schema-side UNIQUE on thread_id are the
 * gates. school_id refers to platform.schools(id) and is
 * denormalised so the Step 4 consumer can write without a
 * tx-time JOIN to msg_threads. last_sender_id refers to
 * platform.platform_users(id).
 *
 * Splitter discipline. This file is splitter-clean per the
 * Cycles 4-13 unbroken streak. Comment text contains no
 * statement-terminator characters.
 */

CREATE TABLE IF NOT EXISTS msg_thread_stats (
  thread_id            UUID PRIMARY KEY,
  school_id            UUID NOT NULL,
  message_count        INT NOT NULL DEFAULT 0,
  last_message_at      TIMESTAMPTZ,
  last_message_preview TEXT,
  last_sender_id       UUID,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT msg_thread_stats_count_chk CHECK (message_count >= 0)
);

CREATE INDEX IF NOT EXISTS msg_thread_stats_school_recent_idx
  ON msg_thread_stats (school_id, last_message_at DESC);

COMMENT ON TABLE msg_thread_stats IS
  'Cycle 14 Step 1. Per-thread denormalised summary maintained by the ThreadStatsConsumer on every msg.message.posted event. The inbox query joins on thread_id to render last_message_preview and last_message_at without scanning the partitioned msg_messages table.';

COMMENT ON COLUMN msg_thread_stats.thread_id IS
  'Soft ref to msg_threads(id) per ADR-001 + ADR-020. No DB FK because msg_threads is HASH-partitioned on school_id and Postgres requires the partition key in the source-side composite for a partition-spanning FK. The schema-side UNIQUE plus the Step 4 consumer are the gates.';

COMMENT ON COLUMN msg_thread_stats.last_message_preview IS
  'First 100 chars of the most recent non-deleted message body, written by the Step 4 ThreadStatsConsumer as LEFT(body, 100). Used by the inbox to render the per-row preview without a sub-query.';
