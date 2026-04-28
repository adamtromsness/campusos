/* 010_msg_queue_processing_state.sql
 * REVIEW-CYCLE3 BLOCKING 2 — fix NotificationDeliveryWorker in-flight semantics.
 *
 * Before this migration, the delivery worker marked queue rows SENT BEFORE
 * actual delivery (Redis ZADD + log write). A crash between the status flip
 * and the delivery left the row permanently SENT with no log row and no
 * retry path — silent loss.
 *
 * This migration adds a PROCESSING state to the queue status CHECK plus a
 * processing_started_at timestamp so a stale-row sweeper can recover rows
 * locked by a worker that died. New state machine:
 *
 *   PENDING    -> PROCESSING (claim under FOR UPDATE in a short tx)
 *   PROCESSING -> SENT       (after Redis + log writes succeed)
 *   PROCESSING -> PENDING    (transient failure, scheduled_for backoff)
 *   PROCESSING -> PENDING    (sweeper recovers stale rows)
 *   PENDING    -> FAILED     (after MAX_ATTEMPTS exhaust)
 *
 * Block-comment style is required per the splitter quirk documented in
 * CLAUDE.md (line-comment headers cause the first statement to be filtered).
 * Idempotent — safe to re-run on demo + test.
 */
ALTER TABLE msg_notification_queue DROP CONSTRAINT IF EXISTS msg_notification_queue_status_chk;
ALTER TABLE msg_notification_queue ADD CONSTRAINT msg_notification_queue_status_chk
    CHECK (status IN ('PENDING','PROCESSING','SENT','FAILED','SKIPPED'));
ALTER TABLE msg_notification_queue ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS msg_notification_queue_processing_idx
    ON msg_notification_queue(processing_started_at)
    WHERE status = 'PROCESSING';
