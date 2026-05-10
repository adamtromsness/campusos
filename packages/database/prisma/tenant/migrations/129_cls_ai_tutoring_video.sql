/* 129_cls_ai_tutoring_video
 *
 * Phase 2 Cycle 7 (P2-7) sub-cycle c — Classroom Advanced.
 *
 * Plan reference — docs/campusos-p2c7-classroom-advanced.html Step 5.
 *
 * Plan migration number is 114 but slot 114 is taken (hr_recruitment).
 * Used 129 per the established Cycle 4 onwards convention of using the
 * next available slot when the planned number is occupied.
 *
 * 8 new tables for the M21 .1 AI tutoring plus lesson video recording
 * surface. Requires AI Inference plus Video Processing extracted services
 * per ADR-004. Step 6 services stub the AI Gateway and Video Processing
 * calls so the pipeline ships even without the upstream services
 * deployed — the schema plus the service layer are complete and the
 * plumbing swaps the stub for the real client when those services land.
 *
 *   cls_ai_tutoring_sessions        — Per-(student, class) tutoring
 *                                     session. status 3-value CHECK
 *                                     ACTIVE / COMPLETED / ABANDONED.
 *                                     total_messages denormalised on
 *                                     the session row so the session
 *                                     list view does not need to join
 *                                     the partitioned messages table.
 *                                     learning_signals_extracted flag
 *                                     gates the Step 6 extract-signals
 *                                     endpoint so a session is only
 *                                     analysed once. Per ADR-004 the
 *                                     subject is a free-text label
 *                                     (Algebra, Photosynthesis, etc.)
 *                                     and the student_id stays in the
 *                                     row but is intentionally NOT
 *                                     embedded into AI prompts — the
 *                                     anonymisation contract lives in
 *                                     AITutoringService.toAnonymousId
 *                                     and is the load-bearing safety
 *                                     rule that the AI Gateway sees
 *                                     only opaque ids.
 *   cls_ai_tutoring_messages        — Per-(session) message in the
 *                                     conversation. role 2-value CHECK
 *                                     STUDENT / ASSISTANT keeps the
 *                                     turn taking shape clean.
 *                                     RANGE-partitioned by created_at
 *                                     monthly across 24 partitions
 *                                     covering 2025-08 to 2027-08
 *                                     matching the msg_messages window.
 *                                     Composite PK (id, created_at)
 *                                     because the partition column
 *                                     must appear in the unique
 *                                     constraint per the existing
 *                                     msg_messages plus pay_ledger
 *                                     plus tsk_tasks precedent.
 *                                     tokens_used per message lets
 *                                     the AIUsageService aggregate
 *                                     by session for the admin
 *                                     dashboard.
 *   cls_ai_tutoring_learning_signals — Per-(session, signal) extracted
 *                                     learning signal. signal_type
 *                                     5-value CHECK MISCONCEPTION /
 *                                     STRENGTH / STRUGGLE / INTEREST /
 *                                     ENGAGEMENT. standard_id is a
 *                                     soft polymorphic FK to either
 *                                     tenant cur_standards or platform
 *                                     cur_standards_platform per the
 *                                     Cycle 23 dual-resolution
 *                                     keystone. Visible to teacher
 *                                     plus counsellor with the
 *                                     student on their own caseload
 *                                     per ADR-004 — never visible to
 *                                     other students. The Step 6
 *                                     read path enforces this.
 *   cls_lesson_recordings           — Per-(lesson) video recording.
 *                                     processing_status 4-state CHECK
 *                                     UPLOADED / TRANSCRIBING /
 *                                     SUMMARISING / COMPLETE tracks
 *                                     the pipeline. s3_key signed-URL
 *                                     pattern matching
 *                                     hr_employee_documents from
 *                                     Cycle 4. Emits video.uploaded
 *                                     after the upload commits so the
 *                                     Video Processing service kicks
 *                                     off transcription. lesson_id
 *                                     is a hard FK to cls_lessons
 *                                     because a recording without
 *                                     its parent lesson is meaningless.
 *   cls_lesson_transcripts          — Per-(recording) transcript.
 *                                     UNIQUE(recording_id) caps each
 *                                     recording at one transcript.
 *                                     Produced by the Video Processing
 *                                     service consuming
 *                                     dev.video.uploaded — the Step 6
 *                                     VideoTranscriptConsumer writes
 *                                     this row INSIDE the same tenant
 *                                     tx as the recording.processing_
 *                                     status flip from TRANSCRIBING
 *                                     to SUMMARISING.
 *   cls_lesson_summaries            — Per-(recording) AI-generated
 *                                     summary. UNIQUE(recording_id)
 *                                     caps each recording at one
 *                                     summary. key_topics plus
 *                                     action_items as TEXT[] arrays
 *                                     for the UI summary card.
 *                                     model_version stored so the
 *                                     summary is auditable and a
 *                                     re-run can be triggered when
 *                                     the model improves. Produced
 *                                     by the AI Inference service
 *                                     consuming a future
 *                                     dev.lesson.transcribed — the
 *                                     Step 6 LessonSummaryConsumer
 *                                     writes this row INSIDE the
 *                                     same tenant tx as the
 *                                     recording.processing_status
 *                                     flip from SUMMARISING to
 *                                     COMPLETE plus emits
 *                                     lesson.summary.ready for the
 *                                     teacher notification path.
 *   cls_ai_usage_log                — Per-(school, AI job) usage and
 *                                     cost log. job_type 4-value
 *                                     CHECK GRADING / SUMMARISATION /
 *                                     TUTORING / STUDENT_SUMMARY.
 *                                     RANGE-partitioned by created_at
 *                                     monthly across 24 partitions
 *                                     covering 2025-08 to 2027-08
 *                                     matching cls_ai_tutoring_messages.
 *                                     Composite PK (id, created_at).
 *                                     Per-tenant quota enforcement
 *                                     via Redis counters in Step 6
 *                                     AIUsageService.assertWithinQuota
 *                                     before every chargeable AI
 *                                     call.
 *   cls_ai_tutoring_opt_outs        — Per-student opt-out record.
 *                                     UNIQUE(student_id) caps each
 *                                     student at one opt-out row.
 *                                     opted_out_by is a soft FK to
 *                                     platform.iam_person — parent
 *                                     for under-13s, student or
 *                                     parent for 13+ per the COPPA
 *                                     plus FERPA convention. When
 *                                     present the Step 6
 *                                     AITutoringService.assertNotOptedOut
 *                                     returns 403 before any AI
 *                                     Gateway call so an opted-out
 *                                     student cannot use the
 *                                     tutoring surface even via a
 *                                     direct API hit.
 *
 * 8 new intra-tenant FKs (CASCADE x 7 plus NO ACTION x 1 on
 * cls_lesson_recordings.lesson_id since a recording without its
 * parent lesson is meaningless but admin keeps the audit trail).
 * 0 cross-schema FKs — every cross-module ref to platform.iam_person
 * follows the soft FK convention per ADR-001/020 and ADR-055.
 *
 * Three load-bearing AI safety rules per ADR-004 enforced at the
 * service layer (the schema cannot enforce them but the service
 * tests pin them as regression tests):
 *   1. AI MUST NEVER write to cls_grades. The AI Tutoring service
 *      reads from cls_grades for context but never inserts or
 *      updates a grade row. The AIUsageService records GRADING
 *      jobs only when an admin explicitly triggers grading
 *      assistance — and even then the result is a suggestion the
 *      teacher reviews, not a write.
 *   2. AI MUST NEVER receive student PII in prompts. The
 *      AITutoringService.toAnonymousId helper hashes student_id
 *      plus session_id into a deterministic but opaque token before
 *      sending any prompt to the AI Gateway. The system prompt
 *      contains the subject only, never the student name or any
 *      PII. The Step 6 spec pins this as a contract test.
 *   3. AI tutoring opt-out is hard-gated. AITutoringService
 *      checks cls_ai_tutoring_opt_outs.UNIQUE(student_id) before
 *      every session start AND every message. An opted-out student
 *      receives 403 with the canonical message — no exceptions
 *      even for school admin override.
 *
 * Splitter convention — no semicolons inside string literals or
 * block comment headers. Every comment uses periods, em-dashes,
 * "and", "plus", or "or" connectives.
 */

CREATE TABLE IF NOT EXISTS cls_ai_tutoring_sessions (
    id UUID PRIMARY KEY,
    school_id UUID NOT NULL,
    student_id UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
    class_id UUID REFERENCES sis_classes(id) ON DELETE SET NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    total_messages INT NOT NULL DEFAULT 0,
    learning_signals_extracted BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_ai_tutoring_sessions_status_chk
      CHECK (status IN ('ACTIVE','COMPLETED','ABANDONED')),
    CONSTRAINT cls_ai_tutoring_sessions_subject_chk
      CHECK (length(trim(subject)) > 0),
    CONSTRAINT cls_ai_tutoring_sessions_messages_chk
      CHECK (total_messages >= 0),
    CONSTRAINT cls_ai_tutoring_sessions_ended_chk
      CHECK (
        (status = 'ACTIVE' AND ended_at IS NULL)
        OR (status IN ('COMPLETED','ABANDONED') AND ended_at IS NOT NULL)
      )
);

CREATE INDEX IF NOT EXISTS cls_ai_tutoring_sessions_student_idx
  ON cls_ai_tutoring_sessions(student_id, started_at DESC);

CREATE INDEX IF NOT EXISTS cls_ai_tutoring_sessions_class_idx
  ON cls_ai_tutoring_sessions(class_id, started_at DESC) WHERE class_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cls_ai_tutoring_sessions_school_active_idx
  ON cls_ai_tutoring_sessions(school_id, started_at DESC) WHERE status = 'ACTIVE';

COMMENT ON TABLE cls_ai_tutoring_sessions IS
  'Per-(student, class) AI tutoring session. status 3-value CHECK ACTIVE / COMPLETED / ABANDONED with multi-column ended_chk pinning ended_at to NULL on ACTIVE and to NOT NULL on every terminal state. AI must never receive student PII in prompts per ADR-004 — the AITutoringService.toAnonymousId helper hashes student_id into an opaque token before any AI Gateway call.';

COMMENT ON COLUMN cls_ai_tutoring_sessions.school_id IS
  'Soft FK to platform.schools(id) per ADR-001/020. Denormalised on the row so the school_active partial INDEX can prune by tenant before the partial filter.';

CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages (
    id UUID NOT NULL,
    session_id UUID NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    tokens_used INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_ai_tutoring_messages_pk PRIMARY KEY (id, created_at),
    CONSTRAINT cls_ai_tutoring_messages_role_chk
      CHECK (role IN ('STUDENT','ASSISTANT')),
    CONSTRAINT cls_ai_tutoring_messages_content_chk
      CHECK (length(trim(content)) > 0),
    CONSTRAINT cls_ai_tutoring_messages_tokens_chk
      CHECK (tokens_used IS NULL OR tokens_used >= 0)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2025_08 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2025_09 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2025-09-01') TO ('2025-10-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2025_10 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2025_11 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2025_12 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2026_01 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2026_02 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2026_03 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2026_04 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2026_05 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2026_06 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2026_07 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2026_08 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2026_09 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2026_10 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2026_11 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2026_12 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2027_01 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2027_02 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2027_03 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2027_04 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2027_05 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2027_06 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE IF NOT EXISTS cls_ai_tutoring_messages_2027_07 PARTITION OF cls_ai_tutoring_messages FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');

CREATE INDEX IF NOT EXISTS cls_ai_tutoring_messages_session_idx
  ON cls_ai_tutoring_messages(session_id, sent_at);

CREATE INDEX IF NOT EXISTS cls_ai_tutoring_messages_session_role_idx
  ON cls_ai_tutoring_messages(session_id, role);

COMMENT ON TABLE cls_ai_tutoring_messages IS
  'Per-(session) message in the conversation. role 2-value CHECK STUDENT / ASSISTANT keeps the turn-taking shape clean. RANGE-partitioned by created_at monthly across 24 partitions covering 2025-08 to 2027-08 matching the msg_messages window. Composite PK (id, created_at) because the partition column must appear in the unique constraint per the existing msg_messages plus pay_ledger plus tsk_tasks precedent. tokens_used per message lets the AIUsageService aggregate by session for the admin dashboard. session_id is intentionally not a hard FK because the partitioned child cannot reference an unpartitioned parent without denormalising the partition column onto the parent — the soft ref is enforced at the application layer.';

COMMENT ON COLUMN cls_ai_tutoring_messages.session_id IS
  'Soft FK to cls_ai_tutoring_sessions(id). Cannot be a hard FK because the parent is unpartitioned and PostgreSQL refuses cross-partition FKs without denormalising the partition column. Service layer validates on every INSERT.';

CREATE TABLE IF NOT EXISTS cls_ai_tutoring_learning_signals (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES cls_ai_tutoring_sessions(id) ON DELETE CASCADE,
    signal_type TEXT NOT NULL,
    signal_description TEXT NOT NULL,
    standard_id UUID,
    confidence NUMERIC(3,2),
    extracted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_ai_tutoring_learning_signals_type_chk
      CHECK (signal_type IN ('MISCONCEPTION','STRENGTH','STRUGGLE','INTEREST','ENGAGEMENT')),
    CONSTRAINT cls_ai_tutoring_learning_signals_description_chk
      CHECK (length(trim(signal_description)) > 0),
    CONSTRAINT cls_ai_tutoring_learning_signals_confidence_chk
      CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE INDEX IF NOT EXISTS cls_ai_tutoring_learning_signals_session_idx
  ON cls_ai_tutoring_learning_signals(session_id);

CREATE INDEX IF NOT EXISTS cls_ai_tutoring_learning_signals_standard_idx
  ON cls_ai_tutoring_learning_signals(standard_id) WHERE standard_id IS NOT NULL;

COMMENT ON TABLE cls_ai_tutoring_learning_signals IS
  'Per-(session, signal) extracted learning signal. signal_type 5-value CHECK MISCONCEPTION / STRENGTH / STRUGGLE / INTEREST / ENGAGEMENT. confidence is a 0-to-1 NUMERIC(3,2) returned by the AI Gateway. Visible to teacher plus counsellor with the student on their own caseload per ADR-004 — never visible to other students. The Step 6 read path enforces this. CASCADE on parent session since signals are meaningless without their conversation.';

COMMENT ON COLUMN cls_ai_tutoring_learning_signals.standard_id IS
  'Soft polymorphic FK to either tenant cur_standards(id) or platform.cur_standards_platform(id) per the Cycle 23 dual-resolution keystone. Validated at the application layer in AITutoringService when the AI Gateway returns a standard match.';

CREATE TABLE IF NOT EXISTS cls_lesson_recordings (
    id UUID PRIMARY KEY,
    lesson_id UUID NOT NULL REFERENCES cls_lessons(id) ON DELETE CASCADE,
    class_id UUID NOT NULL REFERENCES sis_classes(id) ON DELETE CASCADE,
    school_id UUID NOT NULL,
    recorded_by UUID NOT NULL,
    s3_key TEXT NOT NULL,
    duration_seconds INT,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processing_status TEXT NOT NULL DEFAULT 'UPLOADED',
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_lesson_recordings_status_chk
      CHECK (processing_status IN ('UPLOADED','TRANSCRIBING','SUMMARISING','COMPLETE','FAILED')),
    CONSTRAINT cls_lesson_recordings_s3_chk
      CHECK (length(trim(s3_key)) > 0),
    CONSTRAINT cls_lesson_recordings_duration_chk
      CHECK (duration_seconds IS NULL OR duration_seconds >= 0)
);

CREATE INDEX IF NOT EXISTS cls_lesson_recordings_lesson_idx
  ON cls_lesson_recordings(lesson_id);

CREATE INDEX IF NOT EXISTS cls_lesson_recordings_class_idx
  ON cls_lesson_recordings(class_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS cls_lesson_recordings_status_idx
  ON cls_lesson_recordings(school_id, processing_status) WHERE processing_status <> 'COMPLETE';

COMMENT ON TABLE cls_lesson_recordings IS
  'Per-(lesson) video recording. processing_status 5-state CHECK UPLOADED / TRANSCRIBING / SUMMARISING / COMPLETE / FAILED tracks the pipeline. s3_key signed-URL pattern matching hr_employee_documents from Cycle 4. Emits video.uploaded after the upload commits so the Video Processing service kicks off transcription. CASCADE on parent lesson because a recording without its lesson is meaningless.';

COMMENT ON COLUMN cls_lesson_recordings.recorded_by IS
  'Soft FK to hr_employees(id) per ADR-055. The teacher who uploaded the recording.';

CREATE TABLE IF NOT EXISTS cls_lesson_transcripts (
    id UUID PRIMARY KEY,
    recording_id UUID NOT NULL REFERENCES cls_lesson_recordings(id) ON DELETE CASCADE,
    transcript_text TEXT NOT NULL,
    word_count INT,
    language TEXT NOT NULL DEFAULT 'en',
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_lesson_transcripts_recording_uq UNIQUE (recording_id),
    CONSTRAINT cls_lesson_transcripts_text_chk
      CHECK (length(trim(transcript_text)) > 0),
    CONSTRAINT cls_lesson_transcripts_words_chk
      CHECK (word_count IS NULL OR word_count >= 0)
);

CREATE INDEX IF NOT EXISTS cls_lesson_transcripts_language_idx
  ON cls_lesson_transcripts(language);

COMMENT ON TABLE cls_lesson_transcripts IS
  'Per-(recording) transcript. UNIQUE(recording_id) caps each recording at one transcript. Produced by the Video Processing service consuming dev.video.uploaded — the Step 6 VideoTranscriptConsumer writes this row INSIDE the same tenant tx as the recording.processing_status flip from TRANSCRIBING to SUMMARISING. CASCADE on parent recording because a transcript without its source is meaningless.';

CREATE TABLE IF NOT EXISTS cls_lesson_summaries (
    id UUID PRIMARY KEY,
    recording_id UUID NOT NULL REFERENCES cls_lesson_recordings(id) ON DELETE CASCADE,
    summary_text TEXT NOT NULL,
    key_topics TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    action_items TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    model_version TEXT,
    tokens_used INT,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_lesson_summaries_recording_uq UNIQUE (recording_id),
    CONSTRAINT cls_lesson_summaries_text_chk
      CHECK (length(trim(summary_text)) > 0),
    CONSTRAINT cls_lesson_summaries_tokens_chk
      CHECK (tokens_used IS NULL OR tokens_used >= 0)
);

COMMENT ON TABLE cls_lesson_summaries IS
  'Per-(recording) AI-generated summary. UNIQUE(recording_id) caps each recording at one summary. key_topics plus action_items as TEXT[] arrays for the UI summary card. model_version stored so the summary is auditable and a re-run can be triggered when the model improves. Produced by the AI Inference service via the Step 6 LessonSummaryConsumer that writes the row INSIDE the same tenant tx as the recording.processing_status flip from SUMMARISING to COMPLETE plus emits lesson.summary.ready for teacher notification fan-out.';

CREATE TABLE IF NOT EXISTS cls_ai_usage_log (
    id UUID NOT NULL,
    school_id UUID NOT NULL,
    job_type TEXT NOT NULL,
    tokens_used INT NOT NULL DEFAULT 0,
    cost_usd NUMERIC(8,4) NOT NULL DEFAULT 0,
    reference_id UUID,
    actor_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_ai_usage_log_pk PRIMARY KEY (id, created_at),
    CONSTRAINT cls_ai_usage_log_type_chk
      CHECK (job_type IN ('GRADING','SUMMARISATION','TUTORING','STUDENT_SUMMARY')),
    CONSTRAINT cls_ai_usage_log_tokens_chk
      CHECK (tokens_used >= 0),
    CONSTRAINT cls_ai_usage_log_cost_chk
      CHECK (cost_usd >= 0)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2025_08 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2025_09 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2025-09-01') TO ('2025-10-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2025_10 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2025_11 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2025_12 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2026_01 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2026_02 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2026_03 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2026_04 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2026_05 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2026_06 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2026_07 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2026_08 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2026_09 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2026_10 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2026_11 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2026_12 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2027_01 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2027_02 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2027_03 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2027_04 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2027_05 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2027_06 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE IF NOT EXISTS cls_ai_usage_log_2027_07 PARTITION OF cls_ai_usage_log FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');

CREATE INDEX IF NOT EXISTS cls_ai_usage_log_school_created_idx
  ON cls_ai_usage_log(school_id, created_at DESC);

CREATE INDEX IF NOT EXISTS cls_ai_usage_log_school_type_idx
  ON cls_ai_usage_log(school_id, job_type);

CREATE INDEX IF NOT EXISTS cls_ai_usage_log_reference_idx
  ON cls_ai_usage_log(reference_id) WHERE reference_id IS NOT NULL;

COMMENT ON TABLE cls_ai_usage_log IS
  'Per-(school, AI job) usage and cost log. job_type 4-value CHECK GRADING / SUMMARISATION / TUTORING / STUDENT_SUMMARY. RANGE-partitioned by created_at monthly across 24 partitions covering 2025-08 to 2027-08 matching cls_ai_tutoring_messages. Composite PK (id, created_at). Per-tenant quota enforcement via Redis counters in Step 6 AIUsageService.assertWithinQuota before every chargeable AI call. reference_id is a soft polymorphic FK pointing at the originating row — TUTORING points at a session_id, SUMMARISATION at a recording_id, GRADING and STUDENT_SUMMARY at the appropriate aggregate row.';

COMMENT ON COLUMN cls_ai_usage_log.actor_id IS
  'Soft FK to platform.platform_users(id) — the auth account that triggered the AI call. Populated for human-initiated jobs. Worker-initiated jobs (e.g. nightly summarisation) carry NULL.';

CREATE TABLE IF NOT EXISTS cls_ai_tutoring_opt_outs (
    id UUID PRIMARY KEY,
    student_id UUID NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
    opted_out_by UUID NOT NULL,
    opted_out_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cls_ai_tutoring_opt_outs_student_uq UNIQUE (student_id)
);

CREATE INDEX IF NOT EXISTS cls_ai_tutoring_opt_outs_actor_idx
  ON cls_ai_tutoring_opt_outs(opted_out_by);

COMMENT ON TABLE cls_ai_tutoring_opt_outs IS
  'Per-student opt-out record. UNIQUE(student_id) caps each student at one opt-out row. opted_out_by is a soft FK to platform.iam_person — parent for under-13s, student or parent for 13+ per the COPPA plus FERPA convention. When present the Step 6 AITutoringService.assertNotOptedOut returns 403 before any AI Gateway call so an opted-out student cannot use the tutoring surface even via a direct API hit. CASCADE on parent student since the opt-out cannot outlive the student.';

COMMENT ON COLUMN cls_ai_tutoring_opt_outs.opted_out_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020. Parent for under-13s, student for 13+ self-opt-out, or admin for emergency revocation.';
