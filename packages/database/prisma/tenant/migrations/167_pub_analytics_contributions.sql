/* 167_pub_analytics_contributions.sql
 * REVIEW-P2C26 Round 1 BLOCKING 4 — Redelivery-safe analytics
 * contribution ledger for pub_publication_analytics ingestion.
 *
 * The Cycle 25 + P2-26 additive counter approach
 * (`UPDATE pub_publication_analytics SET total_views = total_views + 1`)
 * is safe under concurrency because Postgres serialises UPDATEs on
 * the same row, but it is NOT safe under duplicate delivery of the
 * same source event. When the future Cycle 14 NotificationConsumer
 * fan-out (or the future email-pixel tracker) re-delivers a payload
 * the additive counters would double-count without a deduplication
 * gate.
 *
 * The contribution ledger is the schema-side guarantee. Per (consumer
 * group, source event id, publication id, event type) the ledger
 * holds exactly one row. The Step 4 PublicationAnalyticsService
 * ingestion path INSERTs the ledger row INSIDE the same tenant tx
 * that runs the additive counter UPDATE — on SQLSTATE 23505 the tx
 * rolls back the counter bump and the call short-circuits to a
 * read of the current analytics row.
 *
 * Mirrors the Cycle 11.1 + P2-15 + P2-19 contribution-ledger pattern
 * (svc_wellbeing_checkins_dedup, rpt_event_contributions,
 * msg_push_analytics_contributions, msg_moderation_contributions).
 *
 * Splitter-safe — no semicolons inside string literals or block
 * comments. Idempotent — re-runs are a no-op.
 */

CREATE TABLE IF NOT EXISTS pub_publication_analytics_contributions (
  id                  UUID         PRIMARY KEY,
  consumer_group      TEXT         NOT NULL,
  source_event_id     TEXT         NOT NULL,
  publication_id      UUID         NOT NULL REFERENCES pub_publications(id) ON DELETE CASCADE,
  event_type          TEXT         NOT NULL,
  applied_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT pub_analytics_contrib_event_type_chk
    CHECK (event_type IN ('VIEW', 'OPEN', 'LINK_CLICK', 'BOUNCE'))
);

CREATE UNIQUE INDEX IF NOT EXISTS pub_analytics_contrib_dedup_uq
  ON pub_publication_analytics_contributions
    (consumer_group, source_event_id, publication_id, event_type);

CREATE INDEX IF NOT EXISTS pub_analytics_contrib_publication_idx
  ON pub_publication_analytics_contributions (publication_id, applied_at DESC);

COMMENT ON TABLE pub_publication_analytics_contributions IS
  'REVIEW-P2C26 R-B4 — Redelivery-safe ledger for the additive counter UPDATEs in PublicationAnalyticsService.ingestEvent. The UNIQUE(consumer_group, source_event_id, publication_id, event_type) is the schema-side dedup gate — the service INSERTs the ledger row inside the same tx as the counter UPDATE and short-circuits on 23505. Manual ingestion (no source_event_id supplied) skips the ledger by passing consumer_group=MANUAL and a generated UUID so each call lands one ledger row.';

COMMENT ON COLUMN pub_publication_analytics_contributions.consumer_group IS
  'Kafka consumer group name when the ingestion is driven by Cycle 14 fan-out (e.g. notification-delivery-worker). MANUAL when the route is called directly by the testing UI (each manual call gets a fresh UUID so it never collides).';

COMMENT ON COLUMN pub_publication_analytics_contributions.source_event_id IS
  'Originating event id (Kafka envelope event_id when driven by a consumer — gen_random_uuid()::text when MANUAL). Length is bounded only by the TEXT type since envelope ids are v5-shaped UUIDs.';

COMMENT ON COLUMN pub_publication_analytics_contributions.event_type IS
  'Matches the IngestAnalyticsEventDto.eventType union. Carried in the UNIQUE so two different event types from the same source envelope can both land cleanly when applicable.';
