/*
 * 153_msg_translation_templates.sql — Phase 2 Cycle 19 sub-cycle a (P2-19a).
 *
 * M40 Communications Advanced — 6 of 13 deferred tables. Opens P2-19.
 *
 *   msg_user_language_preferences
 *                                    Per-user language preference plus
 *                                    auto-translate toggles. UNIQUE on
 *                                    user_id so each platform user holds
 *                                    at most one preference row. When
 *                                    auto_translate_incoming is true the
 *                                    TranslationWorker auto-translates
 *                                    every incoming message to
 *                                    preferred_language via the AI
 *                                    Inference service stub.
 *   msg_translations
 *                                    Cached translation result per
 *                                    (message_id, target_language). UNIQUE
 *                                    on the same pair so a duplicate
 *                                    request returns the cached row
 *                                    instead of re-calling the AI service.
 *                                    Per ADR-001 plus ADR-020 the
 *                                    message_id ref is soft because
 *                                    msg_messages is RANGE-partitioned by
 *                                    created_at and a partition-aware FK
 *                                    would require denormalising the
 *                                    partition key. We mirror the
 *                                    msg_message_attachments precedent
 *                                    from Cycle 3 by denormalising
 *                                    message_created_at and indexing the
 *                                    pair. model_version plus confidence
 *                                    capture which AI model ran and how
 *                                    confident the translation is.
 *   msg_templates
 *                                    Reusable message templates with
 *                                    named variable slots. 6-value
 *                                    category CHECK (ANNOUNCEMENT
 *                                    REMINDER EMERGENCY WELCOME FOLLOW_UP
 *                                    CUSTOM). variables JSONB holds an
 *                                    array of {name, description,
 *                                    required, default_value} entries —
 *                                    the TemplateService.render endpoint
 *                                    validates every required variable is
 *                                    provided before interpolation and
 *                                    400s on miss. allowed_roles TEXT[]
 *                                    scopes which IAM role tokens may
 *                                    fetch and render the template.
 *                                    UNIQUE on (school_id, name).
 *   msg_broadcast_segments
 *                                    Reusable audience definitions for
 *                                    targeted broadcast delivery. 6-value
 *                                    segment_type CHECK (ALL_PARENTS
 *                                    ALL_STAFF GRADE_LEVEL CLASS
 *                                    TRANSPORT_ROUTE CUSTOM).
 *                                    filter_criteria JSONB carries the
 *                                    resolution rules (grade_level token,
 *                                    route_ids array, custom_user_ids
 *                                    array etc). Segments resolve to a
 *                                    set of platform_users at send time
 *                                    via the BroadcastSegmentService.
 *                                    UNIQUE on (school_id, name).
 *   msg_broadcast_analytics
 *                                    Per-(broadcast, segment) delivery
 *                                    funnel snapshot. Tracks delivered
 *                                    opened clicked bounced unsubscribed
 *                                    counters plus computed delivery_rate
 *                                    and open_rate. The
 *                                    BroadcastAnalyticsWorker upserts
 *                                    this row from delivery webhook
 *                                    events on the
 *                                    msg.broadcast.delivered topic.
 *                                    UNIQUE on (broadcast_id, segment_id)
 *                                    so a duplicate webhook lands as an
 *                                    update rather than a new row.
 *                                    msg_broadcasts is a forward-
 *                                    referenced table that does not yet
 *                                    exist in tenant migrations — the
 *                                    broadcast_id ref is soft per
 *                                    ADR-001/020.
 *   msg_template_usage_log
 *                                    Per-template usage audit. used_by
 *                                    plus used_at plus optional
 *                                    broadcast_id plus thread_id capture
 *                                    where the template was applied. The
 *                                    TemplateService analytics endpoint
 *                                    reads this for usage count and last-
 *                                    used timestamp. INDEX on
 *                                    (template_id, used_at DESC) backs
 *                                    the analytics hot path.
 *
 * FK summary:
 *   msg_template_usage_log.template_id is a DB-enforced FK to
 *     msg_templates(id) ON DELETE CASCADE — usage rows are meaningless
 *     once the template is hard-deleted.
 *   Every other cross-table ref is soft per ADR-001 plus ADR-020 —
 *     message_id and message_created_at on msg_translations follow the
 *     Cycle 3 msg_message_attachments precedent (partition-aware soft
 *     ref), broadcast_id on msg_broadcast_analytics is a forward
 *     reference to a future Cycle 14 broadcasts table, and every user_id
 *     plus requested_by plus created_by plus used_by ref is soft to
 *     platform.platform_users(id) or platform.iam_person(id).
 *
 * Splitter discipline — no semicolons inside string literals, default
 * expressions, COMMENT bodies, CHECK predicates, or block comments. The
 * splitter cuts on every semicolon regardless of quoting context.
 * Idempotent — safe to re-run.
 */


CREATE TABLE IF NOT EXISTS msg_user_language_preferences (
  id                         UUID PRIMARY KEY,
  user_id                    UUID NOT NULL,
  preferred_language         TEXT NOT NULL DEFAULT 'en',
  auto_translate_incoming    BOOLEAN NOT NULL DEFAULT false,
  auto_translate_outgoing    BOOLEAN NOT NULL DEFAULT false,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT msg_user_lang_pref_user_uq UNIQUE (user_id),
  CONSTRAINT msg_user_lang_pref_lang_chk CHECK (length(trim(preferred_language)) > 0)
);

CREATE INDEX IF NOT EXISTS msg_user_lang_pref_lang_idx
  ON msg_user_language_preferences (preferred_language);

CREATE INDEX IF NOT EXISTS msg_user_lang_pref_auto_in_idx
  ON msg_user_language_preferences (user_id)
  WHERE auto_translate_incoming = true;

COMMENT ON TABLE msg_user_language_preferences IS
  'Per-user language preference plus auto-translate toggles. UNIQUE(user_id) so each platform user holds at most one preference row. When auto_translate_incoming=true the TranslationWorker consumes msg.message.posted and auto-translates the body to preferred_language via the AI Inference service. When auto_translate_outgoing=true the outgoing-message path translates from the sender language to the recipient preferred language before send.';

COMMENT ON COLUMN msg_user_language_preferences.user_id IS
  'Soft FK to platform.platform_users(id) per ADR-001/020.';

COMMENT ON COLUMN msg_user_language_preferences.preferred_language IS
  'IETF BCP 47 language tag (en, es, zh, fr). Free-form TEXT validated by the service layer rather than a CHECK enum so a school can add new languages without a schema migration.';


CREATE TABLE IF NOT EXISTS msg_translations (
  id                       UUID PRIMARY KEY,
  message_id               UUID NOT NULL,
  message_created_at       TIMESTAMPTZ NOT NULL,
  target_language          TEXT NOT NULL,
  translated_text          TEXT NOT NULL,
  source_language          TEXT,
  model_version            TEXT,
  confidence               NUMERIC(3,2),
  translated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  requested_by             UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT msg_translations_pair_uq UNIQUE (message_id, target_language),
  CONSTRAINT msg_translations_lang_chk CHECK (length(trim(target_language)) > 0),
  CONSTRAINT msg_translations_conf_chk CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  CONSTRAINT msg_translations_text_chk CHECK (length(trim(translated_text)) > 0)
);

CREATE INDEX IF NOT EXISTS msg_translations_message_idx
  ON msg_translations (message_id, message_created_at);

CREATE INDEX IF NOT EXISTS msg_translations_lang_idx
  ON msg_translations (target_language);

COMMENT ON TABLE msg_translations IS
  'Cached translation result per (message_id, target_language). UNIQUE(message_id, target_language) is the cache key — a duplicate request returns the cached row instead of re-calling the AI Inference service. confidence is the 0.0-1.0 self-reported confidence from the model. model_version captures which model version produced the translation so a re-translate on model upgrade can be triggered explicitly. requested_by is null for auto-translate path (TranslationWorker) and populated for on-demand path (TranslationService.translate). message_created_at is denormalised so a partition-aware soft ref to msg_messages does not require a partition-keyed FK — mirrors the Cycle 3 msg_message_attachments precedent.';

COMMENT ON COLUMN msg_translations.message_id IS
  'Soft FK to msg_messages(id) per ADR-001/020. msg_messages is RANGE-partitioned by created_at so a DB-enforced FK would require denormalising the partition key — same shape as msg_message_attachments + msg_message_reads from Cycle 3.';

COMMENT ON COLUMN msg_translations.requested_by IS
  'Soft FK to platform.platform_users(id) per ADR-001/020. The user who requested the on-demand translation. NULL when the row was created by the TranslationWorker auto-translate path.';


CREATE TABLE IF NOT EXISTS msg_templates (
  id                  UUID PRIMARY KEY,
  school_id           UUID NOT NULL,
  name                TEXT NOT NULL,
  category            TEXT NOT NULL,
  subject_template    TEXT,
  body_template       TEXT NOT NULL,
  variables           JSONB NOT NULL DEFAULT '[]'::jsonb,
  allowed_roles       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT msg_templates_name_uq UNIQUE (school_id, name),
  CONSTRAINT msg_templates_category_chk CHECK (
    category IN ('ANNOUNCEMENT', 'REMINDER', 'EMERGENCY', 'WELCOME', 'FOLLOW_UP', 'CUSTOM')
  ),
  CONSTRAINT msg_templates_body_chk CHECK (length(trim(body_template)) > 0),
  CONSTRAINT msg_templates_vars_chk CHECK (jsonb_typeof(variables) = 'array')
);

CREATE INDEX IF NOT EXISTS msg_templates_school_active_idx
  ON msg_templates (school_id, is_active);

CREATE INDEX IF NOT EXISTS msg_templates_school_category_idx
  ON msg_templates (school_id, category)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS msg_templates_allowed_roles_gin
  ON msg_templates USING GIN (allowed_roles);

COMMENT ON TABLE msg_templates IS
  'Reusable message templates with named variable slots. 6-value category CHECK (ANNOUNCEMENT REMINDER EMERGENCY WELCOME FOLLOW_UP CUSTOM). variables JSONB carries the variable definition array — each entry is {name, description, required, default_value}. TemplateService.render validates every required variable is provided before interpolation and returns 400 if any required variable is missing. allowed_roles TEXT[] scopes which IAM role tokens may fetch and render — empty array means open to every role with com-001:write. UNIQUE(school_id, name) so a school cannot land two templates with the same name. is_active=false soft-deactivates a retired template while preserving usage history.';

COMMENT ON COLUMN msg_templates.school_id IS
  'Soft FK to platform.schools(id) per ADR-001/020.';

COMMENT ON COLUMN msg_templates.created_by IS
  'Soft FK to platform.platform_users(id) per ADR-001/020. The admin who authored the template.';

COMMENT ON COLUMN msg_templates.variables IS
  'JSONB array of {name, description, required, default_value} entries. Example: [{"name":"student_name","required":true},{"name":"event_date","required":true,"default_value":"TBD"}]. Variables are interpolated into subject_template and body_template using {variable_name} placeholders.';


CREATE TABLE IF NOT EXISTS msg_broadcast_segments (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  name                     TEXT NOT NULL,
  description              TEXT,
  segment_type             TEXT NOT NULL,
  filter_criteria          JSONB NOT NULL DEFAULT '{}'::jsonb,
  estimated_recipients     INT,
  is_active                BOOLEAN NOT NULL DEFAULT true,
  created_by               UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT msg_broadcast_segments_name_uq UNIQUE (school_id, name),
  CONSTRAINT msg_broadcast_segments_type_chk CHECK (
    segment_type IN ('ALL_PARENTS', 'ALL_STAFF', 'GRADE_LEVEL', 'CLASS', 'TRANSPORT_ROUTE', 'CUSTOM')
  ),
  CONSTRAINT msg_broadcast_segments_recipients_chk CHECK (
    estimated_recipients IS NULL OR estimated_recipients >= 0
  ),
  CONSTRAINT msg_broadcast_segments_criteria_chk CHECK (
    jsonb_typeof(filter_criteria) = 'object'
  )
);

CREATE INDEX IF NOT EXISTS msg_broadcast_segments_school_active_idx
  ON msg_broadcast_segments (school_id, is_active);

CREATE INDEX IF NOT EXISTS msg_broadcast_segments_school_type_idx
  ON msg_broadcast_segments (school_id, segment_type)
  WHERE is_active = true;

COMMENT ON TABLE msg_broadcast_segments IS
  'Reusable audience definitions for targeted broadcast delivery. 6-value segment_type CHECK (ALL_PARENTS ALL_STAFF GRADE_LEVEL CLASS TRANSPORT_ROUTE CUSTOM). filter_criteria JSONB carries the resolution rules: GRADE_LEVEL takes {grade_level: "5"}, CLASS takes {class_ids: [uuid, uuid]}, TRANSPORT_ROUTE takes {route_ids: [uuid]}, CUSTOM takes {custom_user_ids: [uuid]}. Segments resolve to a set of platform_users at send time via the BroadcastSegmentService.resolve endpoint. estimated_recipients is a cached preview count refreshed on segment edit. UNIQUE(school_id, name).';

COMMENT ON COLUMN msg_broadcast_segments.school_id IS
  'Soft FK to platform.schools(id) per ADR-001/020.';

COMMENT ON COLUMN msg_broadcast_segments.created_by IS
  'Soft FK to platform.platform_users(id) per ADR-001/020.';


CREATE TABLE IF NOT EXISTS msg_broadcast_analytics (
  id                  UUID PRIMARY KEY,
  broadcast_id        UUID NOT NULL,
  segment_id          UUID,
  total_recipients    INT NOT NULL,
  delivered           INT NOT NULL DEFAULT 0,
  opened              INT NOT NULL DEFAULT 0,
  clicked             INT NOT NULL DEFAULT 0,
  bounced             INT NOT NULL DEFAULT 0,
  unsubscribed        INT NOT NULL DEFAULT 0,
  delivery_rate       NUMERIC(5,4),
  open_rate           NUMERIC(5,4),
  click_rate          NUMERIC(5,4),
  last_updated_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT msg_broadcast_analytics_pair_uq UNIQUE (broadcast_id, segment_id),
  CONSTRAINT msg_broadcast_analytics_total_chk CHECK (total_recipients >= 0),
  CONSTRAINT msg_broadcast_analytics_delivered_chk CHECK (delivered >= 0),
  CONSTRAINT msg_broadcast_analytics_opened_chk CHECK (opened >= 0),
  CONSTRAINT msg_broadcast_analytics_clicked_chk CHECK (clicked >= 0),
  CONSTRAINT msg_broadcast_analytics_bounced_chk CHECK (bounced >= 0),
  CONSTRAINT msg_broadcast_analytics_unsub_chk CHECK (unsubscribed >= 0),
  CONSTRAINT msg_broadcast_analytics_delivery_rate_chk CHECK (
    delivery_rate IS NULL OR (delivery_rate >= 0 AND delivery_rate <= 1)
  ),
  CONSTRAINT msg_broadcast_analytics_open_rate_chk CHECK (
    open_rate IS NULL OR (open_rate >= 0 AND open_rate <= 1)
  ),
  CONSTRAINT msg_broadcast_analytics_click_rate_chk CHECK (
    click_rate IS NULL OR (click_rate >= 0 AND click_rate <= 1)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS msg_broadcast_analytics_broadcast_no_segment_uq
  ON msg_broadcast_analytics (broadcast_id)
  WHERE segment_id IS NULL;

CREATE INDEX IF NOT EXISTS msg_broadcast_analytics_broadcast_idx
  ON msg_broadcast_analytics (broadcast_id);

CREATE INDEX IF NOT EXISTS msg_broadcast_analytics_segment_idx
  ON msg_broadcast_analytics (segment_id)
  WHERE segment_id IS NOT NULL;

COMMENT ON TABLE msg_broadcast_analytics IS
  'Per-(broadcast, segment) delivery funnel snapshot. The BroadcastAnalyticsWorker upserts this row from delivery webhook events on the msg.broadcast.delivered topic. UNIQUE(broadcast_id, segment_id) so a duplicate webhook lands as an update rather than a new row — note that Postgres treats NULL as not-equal in UNIQUE constraints so the partial unique index msg_broadcast_analytics_broadcast_no_segment_uq pins exactly one segment_id=NULL aggregate row per broadcast. delivery_rate = delivered / total_recipients, open_rate = opened / delivered, click_rate = clicked / opened. All three rate columns are computed by the worker on every upsert. Per-segment rows let the dashboard render the funnel split by segment (ALL_PARENTS vs ALL_STAFF for example).';

COMMENT ON COLUMN msg_broadcast_analytics.broadcast_id IS
  'Soft FK to msg_broadcasts(id) per ADR-001/020. msg_broadcasts is a forward-referenced table that does not yet exist in tenant migrations — the Cycle 14 broadcast schema lands as a future addition. Until then the BroadcastAnalyticsWorker treats broadcast_id as opaque.';

COMMENT ON COLUMN msg_broadcast_analytics.segment_id IS
  'Soft FK to msg_broadcast_segments(id) per ADR-001/020. NULL means an aggregate row across every segment in the broadcast (school-wide rollup).';


CREATE TABLE IF NOT EXISTS msg_template_usage_log (
  id              UUID PRIMARY KEY,
  template_id     UUID NOT NULL,
  used_by         UUID NOT NULL,
  used_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  broadcast_id    UUID,
  thread_id       UUID,
  rendered_subject TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT msg_template_usage_log_template_fk FOREIGN KEY (template_id)
    REFERENCES msg_templates(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS msg_template_usage_log_template_used_idx
  ON msg_template_usage_log (template_id, used_at DESC);

CREATE INDEX IF NOT EXISTS msg_template_usage_log_used_by_idx
  ON msg_template_usage_log (used_by, used_at DESC);

COMMENT ON TABLE msg_template_usage_log IS
  'Per-template usage audit. used_by plus used_at plus optional broadcast_id plus thread_id capture where the template was applied. TemplateService analytics reads (template_id, count(*)) plus max(used_at) for the usage dashboard. INDEX(template_id, used_at DESC) backs the hot path. CASCADE on parent template hard-delete because usage rows reference a row that no longer exists — the template_id FK is the only DB-enforced FK in this migration. Hard-deleting a template should be rare in practice (admins use is_active=false instead) so the CASCADE risk surface stays small.';

COMMENT ON COLUMN msg_template_usage_log.used_by IS
  'Soft FK to platform.platform_users(id) per ADR-001/020.';

COMMENT ON COLUMN msg_template_usage_log.broadcast_id IS
  'Soft FK to msg_broadcasts(id) per ADR-001/020. NULL when the template was used on a thread message rather than a broadcast.';

COMMENT ON COLUMN msg_template_usage_log.thread_id IS
  'Soft FK to msg_threads(id) per ADR-001/020. NULL when the template was used on a broadcast rather than a thread message.';
