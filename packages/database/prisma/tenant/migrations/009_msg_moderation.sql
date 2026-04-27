CREATE TABLE IF NOT EXISTS msg_moderation_policies (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    scope TEXT NOT NULL,
    scope_id UUID,
    name TEXT NOT NULL,
    description TEXT,
    keywords TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    keyword_action TEXT NOT NULL,
    sensitivity_threshold INTEGER NOT NULL DEFAULT 50,
    escalation_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT msg_moderation_policies_scope_chk CHECK (scope IN ('PLATFORM','DISTRICT','BUILDING')),
    CONSTRAINT msg_moderation_policies_action_chk CHECK (keyword_action IN ('BLOCK','FLAG_FOR_REVIEW','ESCALATE_TO_COUNSELLOR')),
    CONSTRAINT msg_moderation_policies_threshold_chk CHECK (sensitivity_threshold BETWEEN 0 AND 100)
);
CREATE INDEX IF NOT EXISTS msg_moderation_policies_school_idx ON msg_moderation_policies(school_id);
CREATE INDEX IF NOT EXISTS msg_moderation_policies_scope_active_idx ON msg_moderation_policies(school_id, scope) WHERE is_active = true;
CREATE TABLE IF NOT EXISTS msg_moderation_log (
    id UUID NOT NULL,
    school_id UUID NOT NULL,
    message_id UUID NOT NULL,
    message_created_at TIMESTAMPTZ NOT NULL,
    thread_id UUID,
    sender_id UUID,
    policy_id UUID NOT NULL REFERENCES msg_moderation_policies(id),
    flag_type TEXT NOT NULL,
    matched_keywords TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    severity TEXT NOT NULL DEFAULT 'INFO',
    review_outcome TEXT,
    reviewed_by UUID,
    reviewed_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT msg_moderation_log_pk PRIMARY KEY (id, created_at),
    CONSTRAINT msg_moderation_log_flag_chk CHECK (flag_type IN ('BLOCKED','FLAGGED','ESCALATED')),
    CONSTRAINT msg_moderation_log_severity_chk CHECK (severity IN ('INFO','WARNING','URGENT','EMERGENCY')),
    CONSTRAINT msg_moderation_log_review_chk CHECK (review_outcome IS NULL OR review_outcome IN ('PENDING','RESOLVED','ESCALATED','DISMISSED'))
) PARTITION BY RANGE (created_at);
CREATE INDEX IF NOT EXISTS msg_moderation_log_school_created_idx ON msg_moderation_log(school_id, created_at DESC);
CREATE INDEX IF NOT EXISTS msg_moderation_log_message_idx ON msg_moderation_log(message_id, message_created_at);
CREATE INDEX IF NOT EXISTS msg_moderation_log_sender_idx ON msg_moderation_log(sender_id, created_at DESC) WHERE sender_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS msg_moderation_log_pending_review_idx ON msg_moderation_log(school_id, created_at DESC) WHERE review_outcome = 'PENDING';
CREATE TABLE IF NOT EXISTS msg_moderation_log_2025_08 PARTITION OF msg_moderation_log FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2025_09 PARTITION OF msg_moderation_log FOR VALUES FROM ('2025-09-01') TO ('2025-10-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2025_10 PARTITION OF msg_moderation_log FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2025_11 PARTITION OF msg_moderation_log FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2025_12 PARTITION OF msg_moderation_log FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2026_01 PARTITION OF msg_moderation_log FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2026_02 PARTITION OF msg_moderation_log FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2026_03 PARTITION OF msg_moderation_log FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2026_04 PARTITION OF msg_moderation_log FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2026_05 PARTITION OF msg_moderation_log FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2026_06 PARTITION OF msg_moderation_log FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2026_07 PARTITION OF msg_moderation_log FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2026_08 PARTITION OF msg_moderation_log FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2026_09 PARTITION OF msg_moderation_log FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2026_10 PARTITION OF msg_moderation_log FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2026_11 PARTITION OF msg_moderation_log FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2026_12 PARTITION OF msg_moderation_log FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2027_01 PARTITION OF msg_moderation_log FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2027_02 PARTITION OF msg_moderation_log FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2027_03 PARTITION OF msg_moderation_log FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2027_04 PARTITION OF msg_moderation_log FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2027_05 PARTITION OF msg_moderation_log FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2027_06 PARTITION OF msg_moderation_log FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE IF NOT EXISTS msg_moderation_log_2027_07 PARTITION OF msg_moderation_log FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE IF NOT EXISTS msg_tags (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    name TEXT NOT NULL,
    color TEXT,
    description TEXT,
    is_system BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT msg_tags_school_name_uq UNIQUE (school_id, name)
);
CREATE INDEX IF NOT EXISTS msg_tags_school_idx ON msg_tags(school_id);
CREATE TABLE IF NOT EXISTS msg_user_tags (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    platform_user_id UUID NOT NULL,
    tag_id UUID NOT NULL REFERENCES msg_tags(id) ON DELETE CASCADE,
    assigned_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT msg_user_tags_user_tag_uq UNIQUE (platform_user_id, tag_id)
);
CREATE INDEX IF NOT EXISTS msg_user_tags_user_idx ON msg_user_tags(platform_user_id);
CREATE INDEX IF NOT EXISTS msg_user_tags_school_idx ON msg_user_tags(school_id);
CREATE INDEX IF NOT EXISTS msg_user_tags_tag_idx ON msg_user_tags(tag_id);
CREATE TABLE IF NOT EXISTS msg_user_blocks (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    blocker_id UUID NOT NULL,
    blocked_id UUID NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT msg_user_blocks_pair_uq UNIQUE (blocker_id, blocked_id),
    CONSTRAINT msg_user_blocks_self_chk CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS msg_user_blocks_blocker_idx ON msg_user_blocks(blocker_id);
CREATE INDEX IF NOT EXISTS msg_user_blocks_blocked_idx ON msg_user_blocks(blocked_id);
CREATE INDEX IF NOT EXISTS msg_user_blocks_school_idx ON msg_user_blocks(school_id);
CREATE TABLE IF NOT EXISTS msg_admin_access_log (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    admin_id UUID NOT NULL,
    thread_id UUID NOT NULL,
    reason TEXT NOT NULL,
    accessed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS msg_admin_access_log_admin_idx ON msg_admin_access_log(admin_id, accessed_at DESC);
CREATE INDEX IF NOT EXISTS msg_admin_access_log_thread_idx ON msg_admin_access_log(thread_id, accessed_at DESC);
CREATE INDEX IF NOT EXISTS msg_admin_access_log_school_idx ON msg_admin_access_log(school_id, accessed_at DESC);
COMMENT ON COLUMN msg_moderation_policies.scope_id IS 'Soft reference. Interpretation depends on scope. PLATFORM leaves it NULL, DISTRICT holds platform.organisations(id), BUILDING holds platform.schools(id). Each tenant carries its own copy of the platform-tier and district-tier policies that apply to it, so the moderation interceptor consults a single tenant table without cross-schema reads.';
COMMENT ON COLUMN msg_moderation_log.message_id IS 'Soft reference to msg_messages(id). No DB FK because msg_messages is RANGE-partitioned by created_at and the FK to a partitioned parent is denormalised onto the child by codebase convention. Pattern matches msg_message_attachments.message_id from Cycle 3 Step 1.';
COMMENT ON COLUMN msg_moderation_log.message_created_at IS 'Denormalised partition key (matches msg_messages.created_at). Required so queries pruning by message month can join back to messages without scanning every monthly partition.';
COMMENT ON COLUMN msg_moderation_log.sender_id IS 'Soft reference to platform.platform_users(id). No DB FK per ADR-001/020. Denormalised from msg_messages.sender_id at write time so the moderation queue can filter by sender without joining the partitioned messages table.';
COMMENT ON COLUMN msg_moderation_log.reviewed_by IS 'Soft reference to platform.platform_users(id). No DB FK per ADR-001/020. The admin or counsellor who actioned the flag.';
COMMENT ON COLUMN msg_user_tags.platform_user_id IS 'Soft reference to platform.platform_users(id). No DB FK per ADR-001/020.';
COMMENT ON COLUMN msg_user_tags.assigned_by IS 'Soft reference to platform.platform_users(id). No DB FK per ADR-001/020.';
COMMENT ON COLUMN msg_user_blocks.blocker_id IS 'Soft reference to platform.platform_users(id). No DB FK per ADR-001/020. The user who created the block.';
COMMENT ON COLUMN msg_user_blocks.blocked_id IS 'Soft reference to platform.platform_users(id). No DB FK per ADR-001/020. The user who is blocked.';
COMMENT ON COLUMN msg_admin_access_log.admin_id IS 'Soft reference to platform.platform_users(id). No DB FK per ADR-001/020.';
COMMENT ON COLUMN msg_admin_access_log.thread_id IS 'Soft reference to msg_threads(id). No DB FK because msg_threads is HASH-partitioned by school_id, the codebase convention is to denormalise the partition key on the child table for partition-pruned joins. This audit log carries school_id directly so the pruning predicate is satisfied without a denormalised thread-partition column here.';
COMMENT ON COLUMN msg_admin_access_log.reason IS 'Free-text justification for the admin reading a private thread. FERPA audit trail. NOT NULL because every admin read of a non-participant thread must be justified.';
