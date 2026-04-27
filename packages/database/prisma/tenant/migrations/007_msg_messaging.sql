CREATE TABLE IF NOT EXISTS msg_thread_types (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    allowed_participant_roles TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    is_system BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT msg_thread_types_school_name_uq UNIQUE (school_id, name)
);
CREATE INDEX IF NOT EXISTS msg_thread_types_school_idx ON msg_thread_types(school_id);
CREATE TABLE IF NOT EXISTS msg_threads (
    id UUID NOT NULL,
    school_id UUID NOT NULL,
    thread_type_id UUID NOT NULL REFERENCES msg_thread_types(id),
    subject TEXT,
    created_by UUID NOT NULL,
    last_message_at TIMESTAMPTZ,
    is_archived BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT msg_threads_pk PRIMARY KEY (id, school_id)
) PARTITION BY HASH (school_id);
CREATE INDEX IF NOT EXISTS msg_threads_school_last_msg_idx ON msg_threads(school_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS msg_threads_thread_type_idx ON msg_threads(thread_type_id);
CREATE INDEX IF NOT EXISTS msg_threads_created_by_idx ON msg_threads(created_by);
CREATE TABLE IF NOT EXISTS msg_threads_h00 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 0);
CREATE TABLE IF NOT EXISTS msg_threads_h01 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 1);
CREATE TABLE IF NOT EXISTS msg_threads_h02 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 2);
CREATE TABLE IF NOT EXISTS msg_threads_h03 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 3);
CREATE TABLE IF NOT EXISTS msg_threads_h04 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 4);
CREATE TABLE IF NOT EXISTS msg_threads_h05 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 5);
CREATE TABLE IF NOT EXISTS msg_threads_h06 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 6);
CREATE TABLE IF NOT EXISTS msg_threads_h07 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 7);
CREATE TABLE IF NOT EXISTS msg_threads_h08 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 8);
CREATE TABLE IF NOT EXISTS msg_threads_h09 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 9);
CREATE TABLE IF NOT EXISTS msg_threads_h10 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 10);
CREATE TABLE IF NOT EXISTS msg_threads_h11 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 11);
CREATE TABLE IF NOT EXISTS msg_threads_h12 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 12);
CREATE TABLE IF NOT EXISTS msg_threads_h13 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 13);
CREATE TABLE IF NOT EXISTS msg_threads_h14 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 14);
CREATE TABLE IF NOT EXISTS msg_threads_h15 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 15);
CREATE TABLE IF NOT EXISTS msg_threads_h16 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 16);
CREATE TABLE IF NOT EXISTS msg_threads_h17 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 17);
CREATE TABLE IF NOT EXISTS msg_threads_h18 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 18);
CREATE TABLE IF NOT EXISTS msg_threads_h19 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 19);
CREATE TABLE IF NOT EXISTS msg_threads_h20 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 20);
CREATE TABLE IF NOT EXISTS msg_threads_h21 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 21);
CREATE TABLE IF NOT EXISTS msg_threads_h22 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 22);
CREATE TABLE IF NOT EXISTS msg_threads_h23 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 23);
CREATE TABLE IF NOT EXISTS msg_threads_h24 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 24);
CREATE TABLE IF NOT EXISTS msg_threads_h25 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 25);
CREATE TABLE IF NOT EXISTS msg_threads_h26 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 26);
CREATE TABLE IF NOT EXISTS msg_threads_h27 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 27);
CREATE TABLE IF NOT EXISTS msg_threads_h28 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 28);
CREATE TABLE IF NOT EXISTS msg_threads_h29 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 29);
CREATE TABLE IF NOT EXISTS msg_threads_h30 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 30);
CREATE TABLE IF NOT EXISTS msg_threads_h31 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 31);
CREATE TABLE IF NOT EXISTS msg_threads_h32 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 32);
CREATE TABLE IF NOT EXISTS msg_threads_h33 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 33);
CREATE TABLE IF NOT EXISTS msg_threads_h34 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 34);
CREATE TABLE IF NOT EXISTS msg_threads_h35 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 35);
CREATE TABLE IF NOT EXISTS msg_threads_h36 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 36);
CREATE TABLE IF NOT EXISTS msg_threads_h37 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 37);
CREATE TABLE IF NOT EXISTS msg_threads_h38 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 38);
CREATE TABLE IF NOT EXISTS msg_threads_h39 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 39);
CREATE TABLE IF NOT EXISTS msg_threads_h40 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 40);
CREATE TABLE IF NOT EXISTS msg_threads_h41 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 41);
CREATE TABLE IF NOT EXISTS msg_threads_h42 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 42);
CREATE TABLE IF NOT EXISTS msg_threads_h43 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 43);
CREATE TABLE IF NOT EXISTS msg_threads_h44 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 44);
CREATE TABLE IF NOT EXISTS msg_threads_h45 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 45);
CREATE TABLE IF NOT EXISTS msg_threads_h46 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 46);
CREATE TABLE IF NOT EXISTS msg_threads_h47 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 47);
CREATE TABLE IF NOT EXISTS msg_threads_h48 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 48);
CREATE TABLE IF NOT EXISTS msg_threads_h49 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 49);
CREATE TABLE IF NOT EXISTS msg_threads_h50 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 50);
CREATE TABLE IF NOT EXISTS msg_threads_h51 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 51);
CREATE TABLE IF NOT EXISTS msg_threads_h52 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 52);
CREATE TABLE IF NOT EXISTS msg_threads_h53 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 53);
CREATE TABLE IF NOT EXISTS msg_threads_h54 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 54);
CREATE TABLE IF NOT EXISTS msg_threads_h55 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 55);
CREATE TABLE IF NOT EXISTS msg_threads_h56 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 56);
CREATE TABLE IF NOT EXISTS msg_threads_h57 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 57);
CREATE TABLE IF NOT EXISTS msg_threads_h58 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 58);
CREATE TABLE IF NOT EXISTS msg_threads_h59 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 59);
CREATE TABLE IF NOT EXISTS msg_threads_h60 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 60);
CREATE TABLE IF NOT EXISTS msg_threads_h61 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 61);
CREATE TABLE IF NOT EXISTS msg_threads_h62 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 62);
CREATE TABLE IF NOT EXISTS msg_threads_h63 PARTITION OF msg_threads FOR VALUES WITH (MODULUS 64, REMAINDER 63);
CREATE TABLE IF NOT EXISTS msg_thread_participants (
    id UUID PRIMARY KEY,
    thread_id UUID NOT NULL,
    school_id UUID NOT NULL,
    platform_user_id UUID NOT NULL,
    role TEXT NOT NULL DEFAULT 'PARTICIPANT',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    left_at TIMESTAMPTZ,
    is_muted BOOLEAN NOT NULL DEFAULT false,
    last_read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT msg_thread_participants_role_chk CHECK (role IN ('OWNER','PARTICIPANT','OBSERVER')),
    CONSTRAINT msg_thread_participants_thread_user_uq UNIQUE (thread_id, platform_user_id)
);
CREATE INDEX IF NOT EXISTS msg_thread_participants_thread_idx ON msg_thread_participants(thread_id, school_id);
CREATE INDEX IF NOT EXISTS msg_thread_participants_user_active_idx ON msg_thread_participants(platform_user_id) WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS msg_thread_participants_school_idx ON msg_thread_participants(school_id);
CREATE TABLE IF NOT EXISTS msg_messages (
    id UUID NOT NULL,
    thread_id UUID NOT NULL,
    school_id UUID NOT NULL,
    sender_id UUID NOT NULL,
    body TEXT NOT NULL,
    is_edited BOOLEAN NOT NULL DEFAULT false,
    edited_at TIMESTAMPTZ,
    is_deleted BOOLEAN NOT NULL DEFAULT false,
    deleted_at TIMESTAMPTZ,
    moderation_status TEXT NOT NULL DEFAULT 'CLEAN',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT msg_messages_pk PRIMARY KEY (id, created_at),
    CONSTRAINT msg_messages_moderation_chk CHECK (moderation_status IN ('CLEAN','FLAGGED','BLOCKED','ESCALATED'))
) PARTITION BY RANGE (created_at);
CREATE INDEX IF NOT EXISTS msg_messages_thread_created_idx ON msg_messages(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS msg_messages_school_created_idx ON msg_messages(school_id, created_at DESC);
CREATE INDEX IF NOT EXISTS msg_messages_sender_idx ON msg_messages(sender_id, created_at DESC);
CREATE TABLE IF NOT EXISTS msg_messages_2025_08 PARTITION OF msg_messages FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
CREATE TABLE IF NOT EXISTS msg_messages_2025_09 PARTITION OF msg_messages FOR VALUES FROM ('2025-09-01') TO ('2025-10-01');
CREATE TABLE IF NOT EXISTS msg_messages_2025_10 PARTITION OF msg_messages FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
CREATE TABLE IF NOT EXISTS msg_messages_2025_11 PARTITION OF msg_messages FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE IF NOT EXISTS msg_messages_2025_12 PARTITION OF msg_messages FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE IF NOT EXISTS msg_messages_2026_01 PARTITION OF msg_messages FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE IF NOT EXISTS msg_messages_2026_02 PARTITION OF msg_messages FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE IF NOT EXISTS msg_messages_2026_03 PARTITION OF msg_messages FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS msg_messages_2026_04 PARTITION OF msg_messages FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS msg_messages_2026_05 PARTITION OF msg_messages FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS msg_messages_2026_06 PARTITION OF msg_messages FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS msg_messages_2026_07 PARTITION OF msg_messages FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS msg_messages_2026_08 PARTITION OF msg_messages FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS msg_messages_2026_09 PARTITION OF msg_messages FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS msg_messages_2026_10 PARTITION OF msg_messages FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS msg_messages_2026_11 PARTITION OF msg_messages FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS msg_messages_2026_12 PARTITION OF msg_messages FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS msg_messages_2027_01 PARTITION OF msg_messages FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE IF NOT EXISTS msg_messages_2027_02 PARTITION OF msg_messages FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE IF NOT EXISTS msg_messages_2027_03 PARTITION OF msg_messages FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE IF NOT EXISTS msg_messages_2027_04 PARTITION OF msg_messages FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE IF NOT EXISTS msg_messages_2027_05 PARTITION OF msg_messages FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE IF NOT EXISTS msg_messages_2027_06 PARTITION OF msg_messages FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE IF NOT EXISTS msg_messages_2027_07 PARTITION OF msg_messages FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE IF NOT EXISTS msg_message_attachments (
    id UUID PRIMARY KEY,
    message_id UUID NOT NULL,
    message_created_at TIMESTAMPTZ NOT NULL,
    school_id UUID NOT NULL,
    file_name TEXT NOT NULL,
    s3_key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    file_size_bytes BIGINT NOT NULL,
    uploaded_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS msg_message_attachments_message_idx ON msg_message_attachments(message_id, message_created_at);
CREATE INDEX IF NOT EXISTS msg_message_attachments_school_idx ON msg_message_attachments(school_id);
CREATE TABLE IF NOT EXISTS msg_message_reads (
    id UUID PRIMARY KEY,
    message_id UUID NOT NULL,
    message_created_at TIMESTAMPTZ NOT NULL,
    thread_id UUID NOT NULL,
    reader_id UUID NOT NULL,
    read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT msg_message_reads_message_reader_uq UNIQUE (message_id, reader_id)
);
CREATE INDEX IF NOT EXISTS msg_message_reads_thread_reader_idx ON msg_message_reads(thread_id, reader_id);
CREATE INDEX IF NOT EXISTS msg_message_reads_message_idx ON msg_message_reads(message_id, message_created_at);
COMMENT ON COLUMN msg_threads.created_by IS 'Soft reference to platform.platform_users(id). No DB FK per ADR-001/020. App layer validates the lookup.';
COMMENT ON COLUMN msg_thread_participants.platform_user_id IS 'Soft reference to platform.platform_users(id). No DB FK per ADR-001/020.';
COMMENT ON COLUMN msg_messages.sender_id IS 'Soft reference to platform.platform_users(id). No DB FK per ADR-001/020.';
COMMENT ON COLUMN msg_message_attachments.uploaded_by IS 'Soft reference to platform.platform_users(id). No DB FK per ADR-001/020.';
COMMENT ON COLUMN msg_message_reads.reader_id IS 'Soft reference to platform.platform_users(id). No DB FK per ADR-001/020.';
COMMENT ON COLUMN msg_message_attachments.message_created_at IS 'Denormalised partition key (matches msg_messages.created_at). Required because msg_messages is RANGE-partitioned by created_at, and this column lets queries prune partitions when joining back to messages. Pattern matches sis_attendance_evidence.record_school_year and record_class_id (Cycle 1).';
COMMENT ON COLUMN msg_message_reads.message_created_at IS 'Denormalised partition key (matches msg_messages.created_at). Same rationale as msg_message_attachments.message_created_at.';
