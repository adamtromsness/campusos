/*
 * 154_msg_moderation_push.sql — Phase 2 Cycle 19 sub-cycle b (P2-19b).
 *
 * M40 Communications Advanced — 7 of 13 deferred tables. Closes P2-19.
 *
 *   msg_moderation_rules
 *                                    Three-tier moderation policy
 *                                    catalogue. 3-value scope CHECK
 *                                    (PLATFORM, DISTRICT, BUILDING).
 *                                    school_id is NULL for PLATFORM-tier
 *                                    rules which apply to every tenant.
 *                                    Tenant-scoped rules carry school_id
 *                                    populated. keywords TEXT[] holds the
 *                                    list of phrases that match.
 *                                    keyword_action 3-value CHECK
 *                                    (BLOCK FLAG_FOR_REVIEW
 *                                    ESCALATE_TO_COUNSELLOR) chooses the
 *                                    action when a keyword matches.
 *                                    ai_sensitivity_threshold NUMERIC(3,
 *                                    2) 0.0–1.0 — messages whose AI
 *                                    sensitivity score exceeds this
 *                                    value trip the same action.
 *                                    is_active=false soft-deactivates a
 *                                    rule. The three-tier resolution
 *                                    runs at message-post time: the
 *                                    ModerationWorker reads every active
 *                                    rule matching either the platform
 *                                    tier OR the tenant school
 *                                    (DISTRICT plus BUILDING) and picks
 *                                    the most-restrictive action across
 *                                    all matches.
 *   msg_moderation_actions
 *                                    Per-(message, rule) decision log.
 *                                    4-value action_taken CHECK (BLOCKED
 *                                    FLAGGED_FOR_REVIEW
 *                                    ESCALATED_TO_COUNSELLOR
 *                                    AUTO_APPROVED). matched_keywords
 *                                    TEXT[] records which keywords from
 *                                    the rule actually fired —
 *                                    ai_sensitivity_score captures the
 *                                    AI score at decision time so an
 *                                    appeal review can see what was
 *                                    detected. 4-value review_status
 *                                    CHECK (PENDING RELEASED
 *                                    CONFIRMED_BLOCK ESCALATED) tracks
 *                                    the moderator queue. RANGE
 *                                    partitioned by created_at MONTHLY
 *                                    so the log scales with message
 *                                    volume. Composite PK (id,
 *                                    created_at) per the partition rule
 *                                    that the partition column must
 *                                    appear in every unique constraint.
 *                                    INDEX(message_id, created_at) for
 *                                    the per-message lookup path the
 *                                    AppealService uses.
 *   msg_moderation_appeals
 *                                    Per-action user appeal. UNIQUE on
 *                                    (action_id, action_created_at) so
 *                                    each action accepts at most one
 *                                    appeal. (The composite is required
 *                                    because msg_moderation_actions is
 *                                    partitioned and the schema-side FK
 *                                    cannot land directly on the
 *                                    partitioned parent without a
 *                                    partition-aware reference — we
 *                                    denormalise action_created_at and
 *                                    keep the FK soft, matching the
 *                                    Cycle 3 msg_message_attachments
 *                                    precedent.) 3-value status CHECK
 *                                    (SUBMITTED UPHELD OVERTURNED). On
 *                                    OVERTURNED the AppealService
 *                                    flips the parent action's
 *                                    review_status to RELEASED inside
 *                                    the same tenant tx — the message
 *                                    becomes visible again to
 *                                    recipients downstream.
 *   msg_ai_moderation_results
 *                                    Cached AI moderation analysis per
 *                                    message. UNIQUE on
 *                                    (message_id, message_created_at).
 *                                    sensitivity_score NUMERIC(3,2)
 *                                    0.0–1.0 — the overall sensitivity
 *                                    signal. categories_detected JSONB
 *                                    holds per-category scores e.g.
 *                                    {profanity: 0.9, bullying: 0.3,
 *                                    self_harm: 0.1}. Computed once
 *                                    per message — a redelivered
 *                                    moderation event reads the cached
 *                                    row instead of re-calling the AI
 *                                    Inference service. Mirrors the
 *                                    msg_translations cache pattern
 *                                    from P2-19a.
 *   msg_push_campaigns
 *                                    Push notification campaigns. 4-
 *                                    value status CHECK (DRAFT
 *                                    SCHEDULED SENT CANCELLED). A null
 *                                    scheduled_at means send-now —
 *                                    SchedulingService flips DRAFT to
 *                                    SCHEDULED on the schedule
 *                                    request. PushCampaignWorker polls
 *                                    SCHEDULED rows whose scheduled_at
 *                                    has elapsed, dispatches the push
 *                                    via the push notification
 *                                    service stub, stamps sent_at, and
 *                                    flips status=SENT. The
 *                                    audience_segment_id ref is soft
 *                                    per ADR-001/020 to
 *                                    msg_broadcast_segments — a null
 *                                    means everyone (school-wide
 *                                    broadcast). INDEX(school_id,
 *                                    status, scheduled_at) backs the
 *                                    worker query.
 *   msg_push_analytics
 *                                    Per-campaign engagement funnel.
 *                                    UNIQUE on campaign_id so each
 *                                    campaign holds exactly one
 *                                    analytics row. total_targeted is
 *                                    set when the worker dispatches.
 *                                    Subsequent push delivery
 *                                    callbacks bump delivered, opened,
 *                                    clicked. delivery_rate, open_rate,
 *                                    click_rate are recomputed on every
 *                                    upsert. UPSERT on
 *                                    (campaign_id) is the cache key —
 *                                    a duplicate webhook lands as an
 *                                    update.
 *   msg_push_device_tokens
 *                                    Per-(user, device) push token
 *                                    registry. UNIQUE on
 *                                    (user_id, device_token) so the
 *                                    same token from the same user
 *                                    cannot land twice. 3-value
 *                                    platform CHECK (IOS ANDROID
 *                                    WEB). is_active=false soft-
 *                                    deactivates a device — the
 *                                    PushCampaignWorker reads only
 *                                    is_active=true tokens when
 *                                    resolving the audience. The
 *                                    DELETE handler hard-removes a
 *                                    token because a deregistered
 *                                    device has no audit value.
 *
 * FK summary:
 *   No DB-enforced FKs in this migration. Every cross-table reference
 *   is soft per ADR-001/020:
 *     msg_moderation_actions.message_id           soft → msg_messages
 *                                                 (partitioned)
 *     msg_moderation_actions.rule_id              soft → msg_moderation_rules
 *     msg_moderation_appeals.action_id            soft → msg_moderation_actions
 *                                                 (partitioned)
 *     msg_ai_moderation_results.message_id        soft → msg_messages
 *                                                 (partitioned)
 *     msg_push_campaigns.school_id                soft → platform.schools
 *     msg_push_campaigns.audience_segment_id      soft → msg_broadcast_segments
 *     msg_push_campaigns.created_by               soft → platform.platform_users
 *     msg_push_analytics.campaign_id              soft → msg_push_campaigns
 *     msg_push_device_tokens.user_id              soft → platform.platform_users
 *
 *   The soft-FK pattern is mandatory here because three of the parents
 *   are RANGE-partitioned (msg_messages, msg_moderation_actions
 *   itself), and the cross-schema references (school_id, user_id) live
 *   in the platform schema where ADR-001 forbids DB-enforced FKs from
 *   tenant tables. Service layer validates every supplied UUID via
 *   tenant-scoped reads.
 *
 * Splitter discipline — no semicolons inside string literals, default
 * expressions, COMMENT bodies, CHECK predicates, or block comments. The
 * splitter cuts on every semicolon regardless of quoting context.
 * Idempotent — safe to re-run.
 */


CREATE TABLE IF NOT EXISTS msg_moderation_rules (
  id                          UUID PRIMARY KEY,
  school_id                   UUID,
  scope                       TEXT NOT NULL,
  scope_id                    UUID,
  name                        TEXT NOT NULL,
  description                 TEXT,
  keywords                    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  keyword_action              TEXT NOT NULL,
  ai_sensitivity_threshold    NUMERIC(3,2),
  escalation_rules            JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active                   BOOLEAN NOT NULL DEFAULT true,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT msg_moderation_rules_scope_chk CHECK (
    scope IN ('PLATFORM', 'DISTRICT', 'BUILDING')
  ),
  CONSTRAINT msg_moderation_rules_action_chk CHECK (
    keyword_action IN ('BLOCK', 'FLAG_FOR_REVIEW', 'ESCALATE_TO_COUNSELLOR')
  ),
  CONSTRAINT msg_moderation_rules_threshold_chk CHECK (
    ai_sensitivity_threshold IS NULL
    OR (ai_sensitivity_threshold >= 0 AND ai_sensitivity_threshold <= 1)
  ),
  CONSTRAINT msg_moderation_rules_scope_pair_chk CHECK (
    (scope = 'PLATFORM' AND school_id IS NULL)
    OR (scope <> 'PLATFORM' AND school_id IS NOT NULL)
  ),
  CONSTRAINT msg_moderation_rules_escalation_chk CHECK (
    jsonb_typeof(escalation_rules) = 'object'
  )
);

CREATE INDEX IF NOT EXISTS msg_moderation_rules_scope_active_idx
  ON msg_moderation_rules (scope, is_active);

CREATE INDEX IF NOT EXISTS msg_moderation_rules_school_idx
  ON msg_moderation_rules (school_id)
  WHERE school_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS msg_moderation_rules_keywords_gin
  ON msg_moderation_rules USING GIN (keywords);

COMMENT ON TABLE msg_moderation_rules IS
  'Three-tier moderation policy catalogue. PLATFORM-tier rules apply to every tenant (school_id NULL). DISTRICT or BUILDING tier rules carry school_id populated and are tenant-scoped. The ModerationWorker reads every active rule matching either tier on every msg.message.posted and picks the most-restrictive action across all matches: BLOCK > ESCALATE_TO_COUNSELLOR > FLAG_FOR_REVIEW > none. ai_sensitivity_threshold null skips the AI check for this rule. Rules with both keywords and ai_sensitivity_threshold trip when EITHER keyword matches OR the AI score exceeds the threshold (logical OR — both signals are weighted equally).';

COMMENT ON COLUMN msg_moderation_rules.school_id IS
  'Soft FK to platform.schools(id) per ADR-001/020. NULL for scope=PLATFORM rules which apply to every tenant. The schema CHECK msg_moderation_rules_scope_pair_chk enforces the null-vs-nonnull invariant.';

COMMENT ON COLUMN msg_moderation_rules.created_by IS
  'Soft FK to platform.platform_users(id) per ADR-001/020.';


CREATE TABLE IF NOT EXISTS msg_moderation_actions (
  id                          UUID NOT NULL,
  message_id                  UUID NOT NULL,
  message_created_at          TIMESTAMPTZ NOT NULL,
  rule_id                     UUID NOT NULL,
  action_taken                TEXT NOT NULL,
  matched_keywords            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ai_sensitivity_score        NUMERIC(3,2),
  review_status               TEXT NOT NULL DEFAULT 'PENDING',
  reviewed_by                 UUID,
  reviewed_at                 TIMESTAMPTZ,
  reviewer_notes              TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT msg_moderation_actions_pk PRIMARY KEY (id, created_at),
  CONSTRAINT msg_moderation_actions_taken_chk CHECK (
    action_taken IN ('BLOCKED', 'FLAGGED_FOR_REVIEW', 'ESCALATED_TO_COUNSELLOR', 'AUTO_APPROVED')
  ),
  CONSTRAINT msg_moderation_actions_review_chk CHECK (
    review_status IN ('PENDING', 'RELEASED', 'CONFIRMED_BLOCK', 'ESCALATED')
  ),
  CONSTRAINT msg_moderation_actions_score_chk CHECK (
    ai_sensitivity_score IS NULL
    OR (ai_sensitivity_score >= 0 AND ai_sensitivity_score <= 1)
  ),
  CONSTRAINT msg_moderation_actions_reviewed_chk CHECK (
    (review_status = 'PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (review_status <> 'PENDING' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS msg_moderation_actions_message_idx
  ON msg_moderation_actions (message_id, created_at DESC);

CREATE INDEX IF NOT EXISTS msg_moderation_actions_rule_idx
  ON msg_moderation_actions (rule_id, created_at DESC);

CREATE INDEX IF NOT EXISTS msg_moderation_actions_pending_idx
  ON msg_moderation_actions (created_at DESC)
  WHERE review_status = 'PENDING';

CREATE TABLE IF NOT EXISTS msg_moderation_actions_2025_08 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2025_09 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2025-09-01') TO ('2025-10-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2025_10 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2025_11 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2025_12 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2026_01 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2026_02 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2026_03 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2026_04 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2026_05 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2026_06 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2026_07 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2026_08 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2026_09 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2026_10 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2026_11 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2026_12 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2027_01 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2027_02 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2027_03 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2027_04 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2027_05 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2027_06 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2027_07 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE IF NOT EXISTS msg_moderation_actions_2027_08 PARTITION OF msg_moderation_actions FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');

COMMENT ON TABLE msg_moderation_actions IS
  'Per-(message, rule) decision log. RANGE partitioned by created_at MONTHLY (2025-08 → 2027-08, 25 leaves). Composite PK (id, created_at) because the partition column must appear in every unique constraint. The multi-column reviewed_chk pins (review_status, reviewed_by, reviewed_at) in lockstep — PENDING requires all three NULL, while non-PENDING requires reviewed_by AND reviewed_at populated together. The AppealService OVERTURNED path flips review_status to RELEASED inside the same tenant tx as the appeal mutation so the schema-side lockstep is always satisfied.';

COMMENT ON COLUMN msg_moderation_actions.message_id IS
  'Soft FK to msg_messages(id) per ADR-001/020. msg_messages is RANGE-partitioned by created_at — message_created_at is denormalised so the soft ref remains partition-aware.';

COMMENT ON COLUMN msg_moderation_actions.rule_id IS
  'Soft FK to msg_moderation_rules(id) per ADR-001/020. PLATFORM-tier rules live in tenant rows too because every tenant runs the same set of platform-non-negotiable rules — service layer maintains the copy.';

COMMENT ON COLUMN msg_moderation_actions.reviewed_by IS
  'Soft FK to platform.platform_users(id) per ADR-001/020.';


CREATE TABLE IF NOT EXISTS msg_moderation_appeals (
  id                       UUID PRIMARY KEY,
  action_id                UUID NOT NULL,
  action_created_at        TIMESTAMPTZ NOT NULL,
  appealed_by              UUID NOT NULL,
  appeal_reason            TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'SUBMITTED',
  reviewed_by              UUID,
  reviewed_at              TIMESTAMPTZ,
  reviewer_notes           TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT msg_moderation_appeals_action_uq UNIQUE (action_id, action_created_at),
  CONSTRAINT msg_moderation_appeals_status_chk CHECK (
    status IN ('SUBMITTED', 'UPHELD', 'OVERTURNED')
  ),
  CONSTRAINT msg_moderation_appeals_reason_chk CHECK (
    length(trim(appeal_reason)) > 0
  ),
  CONSTRAINT msg_moderation_appeals_reviewed_chk CHECK (
    (status = 'SUBMITTED' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (status <> 'SUBMITTED' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS msg_moderation_appeals_action_idx
  ON msg_moderation_appeals (action_id, action_created_at);

CREATE INDEX IF NOT EXISTS msg_moderation_appeals_pending_idx
  ON msg_moderation_appeals (created_at DESC)
  WHERE status = 'SUBMITTED';

CREATE INDEX IF NOT EXISTS msg_moderation_appeals_user_idx
  ON msg_moderation_appeals (appealed_by, created_at DESC);

COMMENT ON TABLE msg_moderation_appeals IS
  'Per-action user appeal. UNIQUE(action_id, action_created_at) so each action accepts at most one appeal. The composite key is required because msg_moderation_actions is RANGE-partitioned and a soft FK must denormalise the partition column. On OVERTURNED the AppealService flips the parent action review_status to RELEASED inside the same tenant tx as the appeal status update — the schema-side reviewed_chk lockstep is therefore always satisfied. The Phase 2 punch list carries a Step 4 follow-up to emit msg.message.released so the recipient is notified.';

COMMENT ON COLUMN msg_moderation_appeals.action_id IS
  'Soft FK to msg_moderation_actions(id) per ADR-001/020. msg_moderation_actions is partitioned — action_created_at carries the partition key so the lookup is partition-aware.';

COMMENT ON COLUMN msg_moderation_appeals.appealed_by IS
  'Soft FK to platform.platform_users(id) per ADR-001/020. The user who submitted the appeal — typically the message sender.';

COMMENT ON COLUMN msg_moderation_appeals.reviewed_by IS
  'Soft FK to platform.platform_users(id) per ADR-001/020.';


CREATE TABLE IF NOT EXISTS msg_ai_moderation_results (
  id                      UUID PRIMARY KEY,
  message_id              UUID NOT NULL,
  message_created_at      TIMESTAMPTZ NOT NULL,
  sensitivity_score       NUMERIC(3,2) NOT NULL,
  categories_detected     JSONB NOT NULL DEFAULT '{}'::jsonb,
  model_version           TEXT,
  computed_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT msg_ai_moderation_results_message_uq UNIQUE (message_id, message_created_at),
  CONSTRAINT msg_ai_moderation_results_score_chk CHECK (
    sensitivity_score >= 0 AND sensitivity_score <= 1
  ),
  CONSTRAINT msg_ai_moderation_results_categories_chk CHECK (
    jsonb_typeof(categories_detected) = 'object'
  )
);

CREATE INDEX IF NOT EXISTS msg_ai_moderation_results_message_idx
  ON msg_ai_moderation_results (message_id, message_created_at);

COMMENT ON TABLE msg_ai_moderation_results IS
  'Cached AI moderation analysis per message. UNIQUE(message_id, message_created_at) is the cache key — a redelivered moderation event reads the cached row instead of re-calling the AI Inference service. Mirrors the msg_translations cache pattern from P2-19a. categories_detected JSONB carries per-category scores e.g. {profanity: 0.9, bullying: 0.3, self_harm: 0.1} — the ModerationWorker reads the overall sensitivity_score against the rule threshold and uses categories_detected for the admin queue display.';

COMMENT ON COLUMN msg_ai_moderation_results.message_id IS
  'Soft FK to msg_messages(id) per ADR-001/020. msg_messages is RANGE-partitioned by created_at — message_created_at carries the partition key.';


CREATE TABLE IF NOT EXISTS msg_push_campaigns (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  title                    TEXT NOT NULL,
  body                     TEXT NOT NULL,
  deep_link_url            TEXT,
  image_s3_key             TEXT,
  audience_segment_id      UUID,
  scheduled_at             TIMESTAMPTZ,
  sent_at                  TIMESTAMPTZ,
  status                   TEXT NOT NULL DEFAULT 'DRAFT',
  created_by               UUID NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT msg_push_campaigns_status_chk CHECK (
    status IN ('DRAFT', 'SCHEDULED', 'SENT', 'CANCELLED')
  ),
  CONSTRAINT msg_push_campaigns_title_chk CHECK (length(trim(title)) > 0),
  CONSTRAINT msg_push_campaigns_body_chk CHECK (length(trim(body)) > 0),
  CONSTRAINT msg_push_campaigns_sent_chk CHECK (
    (status IN ('DRAFT', 'SCHEDULED', 'CANCELLED') AND sent_at IS NULL)
    OR (status = 'SENT' AND sent_at IS NOT NULL)
  ),
  CONSTRAINT msg_push_campaigns_scheduled_chk CHECK (
    status <> 'SCHEDULED' OR scheduled_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS msg_push_campaigns_school_status_idx
  ON msg_push_campaigns (school_id, status);

CREATE INDEX IF NOT EXISTS msg_push_campaigns_school_scheduled_idx
  ON msg_push_campaigns (school_id, scheduled_at)
  WHERE status = 'SCHEDULED';

CREATE INDEX IF NOT EXISTS msg_push_campaigns_audience_idx
  ON msg_push_campaigns (audience_segment_id)
  WHERE audience_segment_id IS NOT NULL;

COMMENT ON TABLE msg_push_campaigns IS
  'Push notification campaigns. 4-value status CHECK (DRAFT SCHEDULED SENT CANCELLED). DRAFT is the authoring state — the admin can edit every field. SCHEDULED means the worker will dispatch when scheduled_at elapses, and PATCH /push-campaigns/:id/cancel flips back to CANCELLED before send. SENT is terminal — sent_at is populated atomically with the status flip. The multi-column sent_chk pins (status, sent_at) in lockstep. Tenant-scoped (school_id NOT NULL) because push campaigns are a per-school operational surface.';

COMMENT ON COLUMN msg_push_campaigns.school_id IS
  'Soft FK to platform.schools(id) per ADR-001/020.';

COMMENT ON COLUMN msg_push_campaigns.audience_segment_id IS
  'Soft FK to msg_broadcast_segments(id) per ADR-001/020. NULL means a school-wide broadcast — the PushCampaignWorker resolves to every active device token in the school.';

COMMENT ON COLUMN msg_push_campaigns.created_by IS
  'Soft FK to platform.platform_users(id) per ADR-001/020.';


CREATE TABLE IF NOT EXISTS msg_push_analytics (
  id                   UUID PRIMARY KEY,
  campaign_id          UUID NOT NULL,
  total_targeted       INT NOT NULL,
  total_delivered      INT NOT NULL DEFAULT 0,
  total_opened         INT NOT NULL DEFAULT 0,
  total_clicked        INT NOT NULL DEFAULT 0,
  delivery_rate        NUMERIC(5,4),
  open_rate            NUMERIC(5,4),
  click_rate           NUMERIC(5,4),
  last_updated_at      TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT msg_push_analytics_campaign_uq UNIQUE (campaign_id),
  CONSTRAINT msg_push_analytics_targeted_chk CHECK (total_targeted >= 0),
  CONSTRAINT msg_push_analytics_delivered_chk CHECK (total_delivered >= 0),
  CONSTRAINT msg_push_analytics_opened_chk CHECK (total_opened >= 0),
  CONSTRAINT msg_push_analytics_clicked_chk CHECK (total_clicked >= 0),
  CONSTRAINT msg_push_analytics_delivery_rate_chk CHECK (
    delivery_rate IS NULL OR (delivery_rate >= 0 AND delivery_rate <= 1)
  ),
  CONSTRAINT msg_push_analytics_open_rate_chk CHECK (
    open_rate IS NULL OR (open_rate >= 0 AND open_rate <= 1)
  ),
  CONSTRAINT msg_push_analytics_click_rate_chk CHECK (
    click_rate IS NULL OR (click_rate >= 0 AND click_rate <= 1)
  )
);

CREATE INDEX IF NOT EXISTS msg_push_analytics_campaign_idx
  ON msg_push_analytics (campaign_id);

COMMENT ON TABLE msg_push_analytics IS
  'Per-campaign engagement funnel. UNIQUE(campaign_id) so each campaign holds exactly one analytics row. The PushCampaignWorker initialises total_targeted at dispatch time, then subsequent push delivery callbacks (msg.push.delivered, msg.push.opened, msg.push.clicked) bump the matching counter and recompute delivery_rate = delivered/total, open_rate = opened/delivered, click_rate = clicked/opened. UPSERT on (campaign_id) is the cache key — a duplicate webhook lands as an update rather than a new row.';

COMMENT ON COLUMN msg_push_analytics.campaign_id IS
  'Soft FK to msg_push_campaigns(id) per ADR-001/020.';


CREATE TABLE IF NOT EXISTS msg_push_device_tokens (
  id                UUID PRIMARY KEY,
  user_id           UUID NOT NULL,
  device_token      TEXT NOT NULL,
  platform          TEXT NOT NULL,
  device_name       TEXT,
  app_version       TEXT,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  registered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT msg_push_device_tokens_user_token_uq UNIQUE (user_id, device_token),
  CONSTRAINT msg_push_device_tokens_platform_chk CHECK (
    platform IN ('IOS', 'ANDROID', 'WEB')
  ),
  CONSTRAINT msg_push_device_tokens_token_chk CHECK (length(trim(device_token)) > 0)
);

CREATE INDEX IF NOT EXISTS msg_push_device_tokens_user_active_idx
  ON msg_push_device_tokens (user_id)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS msg_push_device_tokens_platform_idx
  ON msg_push_device_tokens (platform)
  WHERE is_active = true;

COMMENT ON TABLE msg_push_device_tokens IS
  'Per-(user, device) push token registry. UNIQUE(user_id, device_token) so the same token from the same user cannot land twice — re-registering an existing token UPDATEs last_used_at instead of inserting a duplicate. 3-value platform CHECK (IOS ANDROID WEB). is_active=false soft-deactivates a device — the PushCampaignWorker reads only is_active=true tokens when resolving the audience.';

COMMENT ON COLUMN msg_push_device_tokens.user_id IS
  'Soft FK to platform.platform_users(id) per ADR-001/020.';
