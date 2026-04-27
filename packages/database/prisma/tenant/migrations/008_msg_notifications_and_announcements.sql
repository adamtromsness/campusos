CREATE TABLE IF NOT EXISTS msg_alert_types (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    severity TEXT NOT NULL DEFAULT 'INFO',
    default_channels TEXT[] NOT NULL DEFAULT ARRAY['IN_APP']::TEXT[],
    requires_acknowledgement BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT msg_alert_types_school_name_uq UNIQUE (school_id, name),
    CONSTRAINT msg_alert_types_severity_chk CHECK (severity IN ('INFO','WARNING','URGENT','EMERGENCY'))
);
CREATE INDEX IF NOT EXISTS msg_alert_types_school_idx ON msg_alert_types(school_id);
CREATE TABLE IF NOT EXISTS msg_notification_queue (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    recipient_id UUID NOT NULL,
    notification_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'PENDING',
    idempotency_key TEXT,
    scheduled_for TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ,
    failure_reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    correlation_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT msg_notification_queue_status_chk CHECK (status IN ('PENDING','SENT','FAILED','SKIPPED'))
);
CREATE INDEX IF NOT EXISTS msg_notification_queue_pending_idx ON msg_notification_queue(scheduled_for) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS msg_notification_queue_recipient_idx ON msg_notification_queue(recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS msg_notification_queue_school_idx ON msg_notification_queue(school_id);
CREATE INDEX IF NOT EXISTS msg_notification_queue_idempotency_idx ON msg_notification_queue(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS msg_notification_preferences (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    platform_user_id UUID NOT NULL,
    notification_type TEXT NOT NULL,
    channels TEXT[] NOT NULL DEFAULT ARRAY['IN_APP']::TEXT[],
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    quiet_hours_start TIME,
    quiet_hours_end TIME,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT msg_notification_preferences_user_type_uq UNIQUE (platform_user_id, notification_type)
);
CREATE INDEX IF NOT EXISTS msg_notification_preferences_user_idx ON msg_notification_preferences(platform_user_id);
CREATE INDEX IF NOT EXISTS msg_notification_preferences_school_idx ON msg_notification_preferences(school_id);
CREATE TABLE IF NOT EXISTS msg_notification_log (
    id UUID NOT NULL,
    school_id UUID NOT NULL,
    queue_id UUID,
    recipient_id UUID NOT NULL,
    notification_type TEXT NOT NULL,
    channel TEXT NOT NULL,
    status TEXT NOT NULL,
    provider_ref TEXT,
    error_message TEXT,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at TIMESTAMPTZ,
    correlation_id UUID,
    CONSTRAINT msg_notification_log_pk PRIMARY KEY (id, sent_at),
    CONSTRAINT msg_notification_log_channel_chk CHECK (channel IN ('PUSH','EMAIL','SMS','IN_APP')),
    CONSTRAINT msg_notification_log_status_chk CHECK (status IN ('SENT','DELIVERED','FAILED'))
) PARTITION BY RANGE (sent_at);
CREATE INDEX IF NOT EXISTS msg_notification_log_recipient_idx ON msg_notification_log(recipient_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS msg_notification_log_school_idx ON msg_notification_log(school_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS msg_notification_log_queue_idx ON msg_notification_log(queue_id) WHERE queue_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS msg_notification_log_2025_08 PARTITION OF msg_notification_log FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2025_09 PARTITION OF msg_notification_log FOR VALUES FROM ('2025-09-01') TO ('2025-10-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2025_10 PARTITION OF msg_notification_log FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2025_11 PARTITION OF msg_notification_log FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2025_12 PARTITION OF msg_notification_log FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2026_01 PARTITION OF msg_notification_log FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2026_02 PARTITION OF msg_notification_log FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2026_03 PARTITION OF msg_notification_log FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2026_04 PARTITION OF msg_notification_log FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2026_05 PARTITION OF msg_notification_log FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2026_06 PARTITION OF msg_notification_log FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2026_07 PARTITION OF msg_notification_log FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2026_08 PARTITION OF msg_notification_log FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2026_09 PARTITION OF msg_notification_log FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2026_10 PARTITION OF msg_notification_log FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2026_11 PARTITION OF msg_notification_log FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2026_12 PARTITION OF msg_notification_log FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2027_01 PARTITION OF msg_notification_log FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2027_02 PARTITION OF msg_notification_log FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2027_03 PARTITION OF msg_notification_log FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2027_04 PARTITION OF msg_notification_log FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2027_05 PARTITION OF msg_notification_log FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2027_06 PARTITION OF msg_notification_log FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE IF NOT EXISTS msg_notification_log_2027_07 PARTITION OF msg_notification_log FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE IF NOT EXISTS msg_announcements (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    author_id UUID NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    audience_type TEXT NOT NULL,
    audience_ref TEXT,
    alert_type_id UUID REFERENCES msg_alert_types(id),
    publish_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    is_published BOOLEAN NOT NULL DEFAULT false,
    is_recurring BOOLEAN NOT NULL DEFAULT false,
    recurrence_rule TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT msg_announcements_audience_chk CHECK (audience_type IN ('ALL_SCHOOL','CLASS','YEAR_GROUP','ROLE','CUSTOM'))
);
CREATE INDEX IF NOT EXISTS msg_announcements_school_publish_idx ON msg_announcements(school_id, publish_at DESC);
CREATE INDEX IF NOT EXISTS msg_announcements_school_active_idx ON msg_announcements(school_id, publish_at DESC) WHERE is_published = true;
CREATE INDEX IF NOT EXISTS msg_announcements_author_idx ON msg_announcements(author_id);
CREATE INDEX IF NOT EXISTS msg_announcements_alert_type_idx ON msg_announcements(alert_type_id) WHERE alert_type_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS msg_announcement_audiences (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    announcement_id UUID NOT NULL REFERENCES msg_announcements(id) ON DELETE CASCADE,
    platform_user_id UUID NOT NULL,
    delivery_status TEXT NOT NULL DEFAULT 'PENDING',
    delivered_at TIMESTAMPTZ,
    notification_queue_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT msg_announcement_audiences_unique_uq UNIQUE (announcement_id, platform_user_id),
    CONSTRAINT msg_announcement_audiences_status_chk CHECK (delivery_status IN ('PENDING','DELIVERED','FAILED','SKIPPED'))
);
CREATE INDEX IF NOT EXISTS msg_announcement_audiences_user_status_idx ON msg_announcement_audiences(platform_user_id, delivery_status);
CREATE INDEX IF NOT EXISTS msg_announcement_audiences_announcement_idx ON msg_announcement_audiences(announcement_id);
CREATE INDEX IF NOT EXISTS msg_announcement_audiences_school_idx ON msg_announcement_audiences(school_id);
CREATE TABLE IF NOT EXISTS msg_announcement_reads (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    announcement_id UUID NOT NULL REFERENCES msg_announcements(id) ON DELETE CASCADE,
    reader_id UUID NOT NULL,
    read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT msg_announcement_reads_unique_uq UNIQUE (announcement_id, reader_id)
);
CREATE INDEX IF NOT EXISTS msg_announcement_reads_announcement_idx ON msg_announcement_reads(announcement_id);
CREATE INDEX IF NOT EXISTS msg_announcement_reads_reader_idx ON msg_announcement_reads(reader_id);
COMMENT ON COLUMN msg_notification_queue.recipient_id IS 'Soft reference to platform.platform_users(id). No DB FK per ADR-001/020. App layer validates the lookup.';
COMMENT ON COLUMN msg_notification_queue.idempotency_key IS 'Caller-supplied dedup key. The authoritative idempotency check is Redis SET NX (ADR notes the queue avoids a DB UNIQUE constraint to dodge deadlocks during emergency fan-out). The partial index here exists only to support read-side investigation of duplicates and slow lookups by key, not to enforce uniqueness.';
COMMENT ON COLUMN msg_notification_preferences.platform_user_id IS 'Soft reference to platform.platform_users(id). No DB FK per ADR-001/020.';
COMMENT ON COLUMN msg_notification_log.recipient_id IS 'Soft reference to platform.platform_users(id). No DB FK per ADR-001/020.';
COMMENT ON COLUMN msg_notification_log.queue_id IS 'Soft reference to msg_notification_queue(id). Not DB-enforced because msg_notification_log is RANGE-partitioned by sent_at and the FK is informational only, the queue row may be purged before this log row.';
COMMENT ON COLUMN msg_announcements.author_id IS 'Soft reference to platform.platform_users(id). No DB FK per ADR-001/020.';
COMMENT ON COLUMN msg_announcements.audience_ref IS 'Polymorphic target identifier interpreted by the AudienceFanOutWorker (Step 7) based on audience_type. CLASS holds a sis_classes.id UUID rendered as text, YEAR_GROUP holds the grade-level label, ROLE holds an iam role name (e.g. PARENT), and ALL_SCHOOL leaves it NULL. Stored as TEXT to keep one column for all branches.';
COMMENT ON COLUMN msg_announcement_audiences.platform_user_id IS 'Soft reference to platform.platform_users(id). No DB FK per ADR-001/020.';
COMMENT ON COLUMN msg_announcement_audiences.notification_queue_id IS 'Soft reference to msg_notification_queue(id). The fan-out worker writes the queue row first, then this row, so cross-table consistency is app-layer.';
COMMENT ON COLUMN msg_announcement_reads.reader_id IS 'Soft reference to platform.platform_users(id). No DB FK per ADR-001/020.';
