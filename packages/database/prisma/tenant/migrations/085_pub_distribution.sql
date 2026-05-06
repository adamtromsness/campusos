/* ============================================================
 * Cycle 25 — Step 3: Distribution + Subscriptions (Tenant)
 * ============================================================
 *
 * Step 3 closes the M42 schema phase with 4 logical base tables
 * for the distribution model:
 *
 *   - pub_distribution_lists: per-publication targeting list. A
 *     publication may have multiple lists combined at distribute
 *     time. CASCADE on parent publication.
 *
 *   - pub_distribution_rules: rule rows that compose a list.
 *     4-value rule_type CHECK ROLE/GRADE/CLASS/GROUP_MEMBERSHIP.
 *     rule_value is a TEXT slot interpreted via rule_type — for
 *     ROLE the role token PARENT/STAFF/etc., for GRADE the grade
 *     label, for CLASS the sis_classes id as text, for
 *     GROUP_MEMBERSHIP the grp_groups id as text. The Step 7
 *     DistributionService walks the rules and OR-aggregates
 *     matching recipients.
 *
 *   - pub_distribution_recipients: pre-computed delivery rows
 *     populated at distribute time, mirroring the Cycle 14
 *     msg_announcement_audiences pattern. 4-value delivery_status
 *     CHECK PENDING/DELIVERED/OPENED/BOUNCED. UNIQUE(publication,
 *     recipient) so the resolve-and-insert path is idempotent.
 *     recipient_id is a soft FK to platform_users.
 *
 *   - pub_series_subscriptions: per-(series, subscriber) opt-in.
 *     2-value status CHECK SUBSCRIBED/UNSUBSCRIBED. multi-column
 *     status_chk keeps subscribed_at + unsubscribed_at in
 *     lockstep with status. The Step 7 DistributionService
 *     excludes UNSUBSCRIBED recipients from the resolved
 *     audience even when matching rules.
 *
 * 4 new intra-tenant DB-enforced FKs (CASCADE × 3 on parent
 * deletes for lists -> publication, rules -> list, recipients
 * -> publication, plus CASCADE on subscriptions -> series for
 * series lifecycle audit).
 *
 * Splitter-safe — no semicolons inside string literals or block
 * comments. Idempotent — re-runs are a no-op.
 * ============================================================ */

CREATE TABLE IF NOT EXISTS pub_distribution_lists (
  id              UUID PRIMARY KEY,
  publication_id  UUID NOT NULL,
  list_name       TEXT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pub_dist_list_publication_fk FOREIGN KEY (publication_id)
    REFERENCES pub_publications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS pub_dist_list_publication_idx
  ON pub_distribution_lists (publication_id, is_active);

COMMENT ON TABLE pub_distribution_lists IS
  'Cycle 25 — per-publication distribution list. CASCADE on publication delete. A publication may have multiple lists — they are combined at distribute time. Pre-pilot work on multi-list combination semantics is the obvious follow-up.';

CREATE TABLE IF NOT EXISTS pub_distribution_rules (
  id                    UUID PRIMARY KEY,
  distribution_list_id  UUID NOT NULL,
  rule_type             TEXT NOT NULL,
  rule_value            TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pub_dist_rule_type_chk CHECK (
    rule_type IN ('ROLE', 'GRADE', 'CLASS', 'GROUP_MEMBERSHIP')
  ),
  CONSTRAINT pub_dist_rule_list_fk FOREIGN KEY (distribution_list_id)
    REFERENCES pub_distribution_lists(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS pub_dist_rule_list_idx
  ON pub_distribution_rules (distribution_list_id);

COMMENT ON TABLE pub_distribution_rules IS
  'Cycle 25 — rule rows composing a distribution list. CASCADE on parent list. 4-value rule_type CHECK ROLE/GRADE/CLASS/GROUP_MEMBERSHIP. rule_value is interpreted by the Step 7 DistributionService — ROLE expects a role token (PARENT, STAFF, STUDENT), GRADE expects a grade label, CLASS expects a sis_classes(id) as text, GROUP_MEMBERSHIP expects a grp_groups(id) as text. Multiple rules per list are OR-aggregated.';

CREATE TABLE IF NOT EXISTS pub_distribution_recipients (
  id                UUID PRIMARY KEY,
  publication_id    UUID NOT NULL,
  recipient_id      UUID NOT NULL,
  delivery_status   TEXT NOT NULL DEFAULT 'PENDING',
  delivered_at      TIMESTAMPTZ,
  opened_at         TIMESTAMPTZ,
  bounced_reason    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pub_dist_recipient_status_chk CHECK (
    delivery_status IN ('PENDING', 'DELIVERED', 'OPENED', 'BOUNCED')
  ),
  CONSTRAINT pub_dist_recipient_uq UNIQUE (publication_id, recipient_id),
  CONSTRAINT pub_dist_recipient_publication_fk FOREIGN KEY (publication_id)
    REFERENCES pub_publications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS pub_dist_recipient_publication_status_idx
  ON pub_distribution_recipients (publication_id, delivery_status);

CREATE INDEX IF NOT EXISTS pub_dist_recipient_recipient_idx
  ON pub_distribution_recipients (recipient_id);

COMMENT ON TABLE pub_distribution_recipients IS
  'Cycle 25 — pre-computed delivery rows populated by the Step 7 DistributionService.distribute keystone. UNIQUE(publication, recipient) so the resolve-and-insert path is idempotent (ON CONFLICT DO NOTHING on Kafka redelivery). Mirrors the Cycle 14 msg_announcement_audiences pattern. 4-value delivery_status CHECK PENDING/DELIVERED/OPENED/BOUNCED. recipient_id is a soft FK to platform.platform_users per ADR-001/020.';

COMMENT ON COLUMN pub_distribution_recipients.recipient_id IS
  'Soft FK to platform.platform_users(id) per ADR-001/020. Validated at the application layer.';

CREATE TABLE IF NOT EXISTS pub_series_subscriptions (
  id                UUID PRIMARY KEY,
  series_id         UUID NOT NULL,
  subscriber_id     UUID NOT NULL,
  status            TEXT NOT NULL DEFAULT 'SUBSCRIBED',
  subscribed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  unsubscribed_at   TIMESTAMPTZ,
  CONSTRAINT pub_subscription_status_chk CHECK (
    status IN ('SUBSCRIBED', 'UNSUBSCRIBED')
  ),
  CONSTRAINT pub_subscription_lockstep_chk CHECK (
    (status = 'SUBSCRIBED' AND unsubscribed_at IS NULL)
    OR (status = 'UNSUBSCRIBED' AND unsubscribed_at IS NOT NULL)
  ),
  CONSTRAINT pub_subscription_uq UNIQUE (series_id, subscriber_id),
  CONSTRAINT pub_subscription_series_fk FOREIGN KEY (series_id)
    REFERENCES pub_series(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS pub_subscription_subscriber_idx
  ON pub_series_subscriptions (subscriber_id, status);

COMMENT ON TABLE pub_series_subscriptions IS
  'Cycle 25 — per-(series, subscriber) opt-in row. CASCADE on parent series. multi-column lockstep_chk keeps unsubscribed_at populated only when status=UNSUBSCRIBED. The Step 7 DistributionService excludes UNSUBSCRIBED recipients from the resolved audience even when matching rules. subscriber_id is a soft FK to platform.platform_users per ADR-001/020.';

COMMENT ON COLUMN pub_series_subscriptions.subscriber_id IS
  'Soft FK to platform.platform_users(id) per ADR-001/020. Validated at the application layer.';
