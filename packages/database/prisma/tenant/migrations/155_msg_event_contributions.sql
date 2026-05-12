/*
 * 155_msg_event_contributions.sql — REVIEW-P2C19 BLOCKING 5 + 6 fix.
 *
 * Adds two contribution-ledger tables that make the
 * ModerationConsumer (msg.message.posted) and PushAnalyticsConsumer
 * (msg.push.delivered) crash-safe under Kafka redelivery. Mirrors the
 * P2-15 rpt_event_contributions ledger pattern.
 *
 *   msg_moderation_contributions
 *                                    Claim record per
 *                                    (consumer_group, source_event_id,
 *                                    message_id). ModerationService
 *                                    recordAction inserts a row into
 *                                    this table inside the same tenant
 *                                    tx as the msg_moderation_actions
 *                                    INSERT. UNIQUE(consumer_group,
 *                                    source_event_id, message_id)
 *                                    means a redelivered event whose
 *                                    crash-window straddled the claim
 *                                    raises SQLSTATE 23505 on the
 *                                    second pass and the service
 *                                    skips the duplicate INSERT into
 *                                    msg_moderation_actions. Without
 *                                    this ledger a redelivery would
 *                                    insert a duplicate action row
 *                                    even though
 *                                    processWithIdempotency would
 *                                    skip the work — the work has
 *                                    already happened.
 *
 *   msg_push_analytics_contributions
 *                                    Claim record per (consumer_group,
 *                                    source_event_id, campaign_id).
 *                                    PushCampaignService.recordDelivery
 *                                    inserts a row into this table
 *                                    inside the same tx that
 *                                    additively bumps total_delivered
 *                                    / total_opened / total_clicked
 *                                    on msg_push_analytics. UNIQUE
 *                                    (consumer_group, source_event_id,
 *                                    campaign_id) means a redelivered
 *                                    delivery callback raises 23505 on
 *                                    the second pass and the service
 *                                    skips the additive bump.
 *
 * FK summary:
 *   No DB-enforced FKs in this migration. The two table references
 *   (msg_messages, msg_push_campaigns) are partitioned in one case
 *   and live alongside soft-FK columns in the other, so we keep them
 *   soft per ADR-001/020. Service layer validates the parent row.
 *
 * Splitter discipline — no semicolons inside string literals, default
 * expressions, COMMENT bodies, CHECK predicates, or block comments.
 * Idempotent — safe to re-run.
 */


CREATE TABLE IF NOT EXISTS msg_moderation_contributions (
  id                  UUID PRIMARY KEY,
  consumer_group      TEXT NOT NULL,
  source_event_id     UUID NOT NULL,
  message_id          UUID NOT NULL,
  action_id           UUID NOT NULL,
  action_created_at   TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT msg_moderation_contributions_uq UNIQUE (consumer_group, source_event_id, message_id),
  CONSTRAINT msg_moderation_contributions_group_chk CHECK (length(trim(consumer_group)) > 0)
);

CREATE INDEX IF NOT EXISTS msg_moderation_contributions_action_idx
  ON msg_moderation_contributions (action_id);

COMMENT ON TABLE msg_moderation_contributions IS
  'REVIEW-P2C19 BLOCKING 6 — crash-safe moderation claim ledger. ModerationService.recordAction INSERTs a row here in the same tenant tx as the msg_moderation_actions INSERT. UNIQUE(consumer_group, source_event_id, message_id) raises 23505 on redelivery so the service skips the duplicate action INSERT. Mirrors the P2-15 rpt_event_contributions pattern.';


CREATE TABLE IF NOT EXISTS msg_push_analytics_contributions (
  id                  UUID PRIMARY KEY,
  consumer_group      TEXT NOT NULL,
  source_event_id     UUID NOT NULL,
  campaign_id         UUID NOT NULL,
  delivered_delta     INT NOT NULL DEFAULT 0,
  opened_delta        INT NOT NULL DEFAULT 0,
  clicked_delta       INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT msg_push_analytics_contributions_uq UNIQUE (consumer_group, source_event_id, campaign_id),
  CONSTRAINT msg_push_analytics_contributions_group_chk CHECK (length(trim(consumer_group)) > 0),
  CONSTRAINT msg_push_analytics_contributions_deltas_chk CHECK (
    delivered_delta >= 0 AND opened_delta >= 0 AND clicked_delta >= 0
  )
);

CREATE INDEX IF NOT EXISTS msg_push_analytics_contributions_campaign_idx
  ON msg_push_analytics_contributions (campaign_id, created_at DESC);

COMMENT ON TABLE msg_push_analytics_contributions IS
  'REVIEW-P2C19 BLOCKING 5 — crash-safe push analytics claim ledger. PushCampaignService.recordDelivery INSERTs a row here in the same tenant tx as the additive bump to msg_push_analytics. UNIQUE(consumer_group, source_event_id, campaign_id) raises 23505 on redelivery so the service skips the additive bump. The delivered_delta / opened_delta / clicked_delta columns preserve the per-event contribution for replay or audit.';
