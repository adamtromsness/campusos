/* 131_ath_streaming_officials.sql
 *
 * Phase 2 Cycle 8 (P2-8) sub-cycle b — Athletics Advanced (digital layer).
 *
 * Plan reference — docs/campusos-p2c8-athletics-advanced.html Step 3.
 *
 * Plan migration number is 116 but slot 116 is taken (hr_appraisals).
 * Used 131 per the established Cycle 4 onwards convention of using the
 * next available slot when the planned number is occupied. Companion
 * platform-schema migration ships under
 * 20260510_add_p2c8_athletics_officials in the platform Prisma migrations
 * folder.
 *
 * 7 new tenant base tables for the M66 .1 athletics streaming + officials
 * marketplace + recruiting profiles surface. The 2 platform-schema tables
 * (platform_official_profiles + platform_official_availability) ship
 * separately because per ADR-063 officials are portable across schools
 * and must live above the tenant boundary.
 *
 *   ath_game_streams              — Per-game streaming configuration.
 *                                   UNIQUE(game_id) one stream per game.
 *                                   stream_status 4-value CHECK SCHEDULED,
 *                                   LIVE, ENDED, FAILED. access_level
 *                                   4-value CHECK PUBLIC, SCHOOL_ONLY,
 *                                   BOTH_SCHOOLS, COACHES_ONLY enforced
 *                                   at the request layer per ADR-068
 *                                   (athletic events are public
 *                                   performances — photo privacy flags
 *                                   do not apply). recording_s3_key plus
 *                                   recording_duration_seconds populate
 *                                   when status flips to ENDED with the
 *                                   recording finalised.
 *
 *   ath_highlight_clips           — Per-(stream, student) extracted clip.
 *                                   start_time_seconds plus end_time_seconds
 *                                   define the cut. consent_status 3-value
 *                                   CHECK PENDING, CONSENTED, DECLINED is
 *                                   the gate that the Step 4 service
 *                                   enforces before added_to_portfolio
 *                                   flips true. portfolio_item_id is a
 *                                   soft ref to pfl_portfolio_items
 *                                   populated when the clip is linked to
 *                                   the student's Cycle 24 portfolio.
 *
 *   ath_game_recordings           — Per-game full recording catalogue
 *                                   distinct from stream-derived
 *                                   recordings. recording_type 3-value
 *                                   CHECK FULL_GAME, HIGHLIGHT_REEL,
 *                                   COACHES_FILM. uploaded_by tracks the
 *                                   author. INDEX(game_id) for the
 *                                   per-game media tab.
 *
 *   ath_official_assignments      — Per-(game, official) assignment.
 *                                   official_profile_id is a soft ref to
 *                                   platform.platform_official_profiles
 *                                   per ADR-001/020 (officials live
 *                                   above the tenant boundary). role
 *                                   7-value CHECK HEAD_REFEREE,
 *                                   ASSISTANT_REFEREE, UMPIRE,
 *                                   LINE_JUDGE, SCORER, TIMER, OTHER.
 *                                   status 6-value CHECK POSTED,
 *                                   ACCEPTED, CONFIRMED, COMPLETED,
 *                                   CANCELLED, NO_SHOW. payment_status
 *                                   3-value CHECK PENDING, PROCESSED,
 *                                   PAID. Emits
 *                                   ath.official.assignment.completed
 *                                   on COMPLETED transition.
 *
 *   ath_official_ratings          — Per-(assignment, rater_type)
 *                                   bidirectional rating. rater_type
 *                                   2-value CHECK SCHOOL_RATES_OFFICIAL
 *                                   plus OFFICIAL_RATES_SCHOOL.
 *                                   UNIQUE(assignment_id, rater_type)
 *                                   so each direction lands at most one
 *                                   row per assignment. All five
 *                                   numeric scores in [1, 5]. comments
 *                                   is free-form TEXT. The Step 4
 *                                   service computes per-official
 *                                   averages from this table for the
 *                                   marketplace browse UI.
 *
 *   ath_recruiting_profiles       — Per-student recruiting profile.
 *                                   UNIQUE(student_id) one profile per
 *                                   athlete. Student-owned — service
 *                                   layer refuses non-self non-admin
 *                                   non-coach writes. is_published
 *                                   gates whether the profile surfaces
 *                                   to college recruiters. gpa is a
 *                                   denormalised snapshot from the
 *                                   Cycle 29 rpt_student_academic_summary
 *                                   read model — refreshed at
 *                                   publication time, not maintained
 *                                   live.
 *
 *   ath_recruiting_interests      — Per-(profile, college) interest
 *                                   tracker. interest_level 4-value
 *                                   CHECK EXPLORING, INTERESTED,
 *                                   APPLIED, COMMITTED. Multiple
 *                                   colleges per profile expected.
 *                                   INDEX(recruiting_profile_id) drives
 *                                   the per-profile interest list.
 *
 * 7 new intra-tenant FKs plus 2 cross-schema soft refs to
 * platform.platform_official_profiles per ADR-001/020 + ADR-063.
 * 0 cross-schema DB-enforced FKs (officials live in the platform
 * schema and must be reachable as soft UUIDs from every tenant).
 *
 * Splitter convention — no semicolons inside string literals or block
 * comment headers. Every comment uses periods, em-dashes, "and", or
 * "plus" connectives.
 */

CREATE TABLE IF NOT EXISTS ath_game_streams (
    id UUID PRIMARY KEY,
    game_id UUID NOT NULL REFERENCES ath_games(id) ON DELETE CASCADE,
    stream_url TEXT,
    stream_status TEXT NOT NULL DEFAULT 'SCHEDULED',
    access_level TEXT NOT NULL DEFAULT 'SCHOOL_ONLY',
    recording_s3_key TEXT,
    recording_duration_seconds INT,
    configured_by UUID NOT NULL,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ath_game_streams_status_chk
      CHECK (stream_status IN ('SCHEDULED','LIVE','ENDED','FAILED')),
    CONSTRAINT ath_game_streams_access_chk
      CHECK (access_level IN ('PUBLIC','SCHOOL_ONLY','BOTH_SCHOOLS','COACHES_ONLY')),
    CONSTRAINT ath_game_streams_duration_chk
      CHECK (recording_duration_seconds IS NULL OR recording_duration_seconds >= 0),
    CONSTRAINT ath_game_streams_lifecycle_chk
      CHECK (
        (stream_status = 'SCHEDULED' AND started_at IS NULL AND ended_at IS NULL)
        OR (stream_status = 'LIVE' AND started_at IS NOT NULL AND ended_at IS NULL)
        OR (stream_status = 'ENDED' AND started_at IS NOT NULL AND ended_at IS NOT NULL)
        OR (stream_status = 'FAILED')
      )
);

CREATE UNIQUE INDEX IF NOT EXISTS ath_game_streams_game_uq
  ON ath_game_streams(game_id);

CREATE INDEX IF NOT EXISTS ath_game_streams_status_idx
  ON ath_game_streams(stream_status)
  WHERE stream_status IN ('SCHEDULED','LIVE');

COMMENT ON TABLE ath_game_streams IS
  'Per-game streaming configuration. UNIQUE(game_id) caps each game at one stream. The Step 4 GameStreamService is the canonical writer. stream_status 4-value CHECK drives the lifecycle SCHEDULED to LIVE to ENDED. Multi-column lifecycle CHECK keeps started_at and ended_at consistent with status. access_level 4-value CHECK applied at the request layer per ADR-068 (athletic events are public performances by default). configured_by is the AD account id who set up the stream.';

COMMENT ON COLUMN ath_game_streams.configured_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020 + ADR-055. The AD or staff member who configured the stream.';

COMMENT ON COLUMN ath_game_streams.access_level IS
  'PUBLIC streams open to anonymous viewers (links shareable). SCHOOL_ONLY restricts to authenticated users in the home school. BOTH_SCHOOLS opens to authenticated users in both home and away schools. COACHES_ONLY restricts to coaching staff for game-film analysis.';

CREATE TABLE IF NOT EXISTS ath_highlight_clips (
    id UUID PRIMARY KEY,
    stream_id UUID NOT NULL REFERENCES ath_game_streams(id) ON DELETE CASCADE,
    student_id UUID NOT NULL,
    start_time_seconds INT NOT NULL,
    end_time_seconds INT NOT NULL,
    title TEXT,
    description TEXT,
    s3_key TEXT NOT NULL,
    added_to_portfolio BOOLEAN NOT NULL DEFAULT false,
    portfolio_item_id UUID,
    consent_status TEXT NOT NULL DEFAULT 'PENDING',
    consent_recorded_at TIMESTAMPTZ,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ath_highlight_clips_consent_chk
      CHECK (consent_status IN ('PENDING','CONSENTED','DECLINED')),
    CONSTRAINT ath_highlight_clips_window_chk
      CHECK (start_time_seconds >= 0 AND end_time_seconds > start_time_seconds),
    CONSTRAINT ath_highlight_clips_s3_chk CHECK (length(trim(s3_key)) > 0),
    CONSTRAINT ath_highlight_clips_portfolio_consent_chk
      CHECK (added_to_portfolio = false OR consent_status = 'CONSENTED')
);

CREATE INDEX IF NOT EXISTS ath_highlight_clips_student_idx
  ON ath_highlight_clips(student_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ath_highlight_clips_stream_idx
  ON ath_highlight_clips(stream_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ath_highlight_clips_pending_consent_idx
  ON ath_highlight_clips(student_id, consent_status)
  WHERE consent_status = 'PENDING';

COMMENT ON TABLE ath_highlight_clips IS
  'Per-(stream, student) extracted highlight clip. The Step 4 GameStreamService writes one row per clip extracted by an AD or coach via timeline scrubbing. consent_status 3-value CHECK PENDING, CONSENTED, DECLINED is the gate the service enforces before flipping added_to_portfolio true. Multi-column portfolio_consent_chk is the schema-side belt-and-braces — added_to_portfolio cannot be true unless consent_status is CONSENTED. The portfolio_item_id is populated when the Step 4 service emits the link to Cycle 24 pfl_portfolio_items via Kafka.';

COMMENT ON COLUMN ath_highlight_clips.student_id IS
  'Soft FK to sis_students(id) per ADR-001/020. The athlete featured in the clip.';

COMMENT ON COLUMN ath_highlight_clips.portfolio_item_id IS
  'Soft FK to pfl_portfolio_items(id) per ADR-001/020. Populated when the clip is added to the student portfolio. Cycle 24 portfolio module is the canonical writer of pfl_portfolio_items rows — the Step 4 service emits the link request and stamps this column on success.';

COMMENT ON COLUMN ath_highlight_clips.created_by IS
  'Soft FK to platform.iam_person(id). The AD, coach, or admin who extracted the clip.';

CREATE TABLE IF NOT EXISTS ath_game_recordings (
    id UUID PRIMARY KEY,
    game_id UUID NOT NULL REFERENCES ath_games(id) ON DELETE CASCADE,
    recording_type TEXT NOT NULL,
    s3_key TEXT NOT NULL,
    duration_seconds INT,
    title TEXT,
    description TEXT,
    uploaded_by UUID,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ath_game_recordings_type_chk
      CHECK (recording_type IN ('FULL_GAME','HIGHLIGHT_REEL','COACHES_FILM')),
    CONSTRAINT ath_game_recordings_duration_chk
      CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
    CONSTRAINT ath_game_recordings_s3_chk CHECK (length(trim(s3_key)) > 0)
);

CREATE INDEX IF NOT EXISTS ath_game_recordings_game_idx
  ON ath_game_recordings(game_id, uploaded_at DESC);

CREATE INDEX IF NOT EXISTS ath_game_recordings_type_idx
  ON ath_game_recordings(game_id, recording_type);

COMMENT ON TABLE ath_game_recordings IS
  'Per-game recording catalogue distinct from the stream-recorded video on ath_game_streams. recording_type 3-value CHECK FULL_GAME, HIGHLIGHT_REEL, COACHES_FILM separates the canonical full-game recording from edited highlight reels and analysis film for coaches. uploaded_by tracks the staff member. CASCADE on parent game delete since a recording without its game is meaningless.';

COMMENT ON COLUMN ath_game_recordings.uploaded_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020 + ADR-055. The staff member who uploaded the recording.';

CREATE TABLE IF NOT EXISTS ath_official_assignments (
    id UUID PRIMARY KEY,
    game_id UUID NOT NULL REFERENCES ath_games(id) ON DELETE CASCADE,
    official_profile_id UUID NOT NULL,
    role TEXT NOT NULL,
    fee NUMERIC(8,2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'POSTED',
    payment_status TEXT NOT NULL DEFAULT 'PENDING',
    accepted_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    cancellation_reason TEXT,
    notes TEXT,
    assigned_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ath_official_assignments_role_chk
      CHECK (role IN ('HEAD_REFEREE','ASSISTANT_REFEREE','UMPIRE','LINE_JUDGE','SCORER','TIMER','OTHER')),
    CONSTRAINT ath_official_assignments_status_chk
      CHECK (status IN ('POSTED','ACCEPTED','CONFIRMED','COMPLETED','CANCELLED','NO_SHOW')),
    CONSTRAINT ath_official_assignments_payment_chk
      CHECK (payment_status IN ('PENDING','PROCESSED','PAID')),
    CONSTRAINT ath_official_assignments_fee_chk CHECK (fee >= 0),
    CONSTRAINT ath_official_assignments_cancel_chk
      CHECK (
        (status <> 'CANCELLED' AND cancelled_at IS NULL)
        OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL AND length(trim(cancellation_reason)) > 0)
      ),
    CONSTRAINT ath_official_assignments_completed_chk
      CHECK (
        (status <> 'COMPLETED' AND completed_at IS NULL)
        OR (status = 'COMPLETED' AND completed_at IS NOT NULL)
      )
);

CREATE UNIQUE INDEX IF NOT EXISTS ath_official_assignments_game_role_uq
  ON ath_official_assignments(game_id, official_profile_id, role)
  WHERE status NOT IN ('CANCELLED','NO_SHOW');

CREATE INDEX IF NOT EXISTS ath_official_assignments_official_idx
  ON ath_official_assignments(official_profile_id, status);

CREATE INDEX IF NOT EXISTS ath_official_assignments_game_idx
  ON ath_official_assignments(game_id, status);

CREATE INDEX IF NOT EXISTS ath_official_assignments_payment_pending_idx
  ON ath_official_assignments(payment_status, completed_at)
  WHERE status = 'COMPLETED' AND payment_status = 'PENDING';

COMMENT ON TABLE ath_official_assignments IS
  'Per-(game, official, role) assignment row. official_profile_id is a soft FK to platform.platform_official_profiles per ADR-001/020 + ADR-063 (officials are portable across schools and live above the tenant boundary). status 6-value CHECK drives the lifecycle POSTED to ACCEPTED to CONFIRMED to COMPLETED with CANCELLED and NO_SHOW as terminal alternates. payment_status 3-value CHECK separates fee approval from disbursement. Multi-column cancel_chk and completed_chk lockstep keep the timestamp columns consistent with status. Partial UNIQUE prevents double-assignment of the same official to the same game role unless the prior assignment is CANCELLED or NO_SHOW. Emits ath.official.assignment.completed on the COMPLETED transition.';

COMMENT ON COLUMN ath_official_assignments.official_profile_id IS
  'Soft FK to platform.platform_official_profiles(id) per ADR-001/020 + ADR-063. Officials live in the platform schema so a single official can work games across multiple schools without per-tenant duplication.';

COMMENT ON COLUMN ath_official_assignments.assigned_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020 + ADR-055. The AD or staff member who assigned the official.';

CREATE TABLE IF NOT EXISTS ath_official_ratings (
    id UUID PRIMARY KEY,
    assignment_id UUID NOT NULL REFERENCES ath_official_assignments(id) ON DELETE CASCADE,
    rater_type TEXT NOT NULL,
    professionalism INT,
    knowledge INT,
    communication INT,
    punctuality INT,
    overall INT NOT NULL,
    comments TEXT,
    rated_by UUID,
    rated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ath_official_ratings_type_chk
      CHECK (rater_type IN ('SCHOOL_RATES_OFFICIAL','OFFICIAL_RATES_SCHOOL')),
    CONSTRAINT ath_official_ratings_professionalism_chk
      CHECK (professionalism IS NULL OR (professionalism >= 1 AND professionalism <= 5)),
    CONSTRAINT ath_official_ratings_knowledge_chk
      CHECK (knowledge IS NULL OR (knowledge >= 1 AND knowledge <= 5)),
    CONSTRAINT ath_official_ratings_communication_chk
      CHECK (communication IS NULL OR (communication >= 1 AND communication <= 5)),
    CONSTRAINT ath_official_ratings_punctuality_chk
      CHECK (punctuality IS NULL OR (punctuality >= 1 AND punctuality <= 5)),
    CONSTRAINT ath_official_ratings_overall_chk
      CHECK (overall >= 1 AND overall <= 5)
);

CREATE UNIQUE INDEX IF NOT EXISTS ath_official_ratings_assignment_type_uq
  ON ath_official_ratings(assignment_id, rater_type);

CREATE INDEX IF NOT EXISTS ath_official_ratings_assignment_idx
  ON ath_official_ratings(assignment_id, rated_at DESC);

COMMENT ON TABLE ath_official_ratings IS
  'Per-(assignment, rater_type) rating row. rater_type 2-value CHECK SCHOOL_RATES_OFFICIAL plus OFFICIAL_RATES_SCHOOL drives the bidirectional rating contract — both sides have voice. UNIQUE keystone caps each direction at one row per assignment. The four sub-scores are nullable so a rater can submit only the overall score — overall is required. The Step 4 OfficialService aggregates per-official averages over the SCHOOL_RATES_OFFICIAL rows for the marketplace browse UI plus per-school averages aggregate over OFFICIAL_RATES_SCHOOL rows for the AD reputation dashboard.';

COMMENT ON COLUMN ath_official_ratings.rated_by IS
  'Soft FK to platform.iam_person(id). For SCHOOL_RATES_OFFICIAL this is the AD account and for OFFICIAL_RATES_SCHOOL this is the official account (resolved via platform_official_profiles.person_id).';

CREATE TABLE IF NOT EXISTS ath_recruiting_profiles (
    id UUID PRIMARY KEY,
    student_id UUID NOT NULL,
    sport TEXT NOT NULL,
    graduation_year INT NOT NULL,
    position TEXT,
    height_inches INT,
    weight_lbs INT,
    gpa NUMERIC(4,3),
    gpa_snapshot_at TIMESTAMPTZ,
    highlight_reel_s3_key TEXT,
    is_published BOOLEAN NOT NULL DEFAULT false,
    published_at TIMESTAMPTZ,
    coach_recommendation TEXT,
    achievements TEXT,
    contact_email TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ath_recruiting_profiles_sport_chk
      CHECK (length(trim(sport)) > 0),
    CONSTRAINT ath_recruiting_profiles_year_chk
      CHECK (graduation_year >= 2024 AND graduation_year <= 2050),
    CONSTRAINT ath_recruiting_profiles_height_chk
      CHECK (height_inches IS NULL OR (height_inches > 0 AND height_inches <= 120)),
    CONSTRAINT ath_recruiting_profiles_weight_chk
      CHECK (weight_lbs IS NULL OR (weight_lbs > 0 AND weight_lbs <= 1000)),
    CONSTRAINT ath_recruiting_profiles_gpa_chk
      CHECK (gpa IS NULL OR (gpa >= 0 AND gpa <= 5)),
    CONSTRAINT ath_recruiting_profiles_published_chk
      CHECK (
        (is_published = false AND published_at IS NULL)
        OR (is_published = true AND published_at IS NOT NULL)
      )
);

CREATE UNIQUE INDEX IF NOT EXISTS ath_recruiting_profiles_student_uq
  ON ath_recruiting_profiles(student_id);

CREATE INDEX IF NOT EXISTS ath_recruiting_profiles_published_idx
  ON ath_recruiting_profiles(graduation_year, sport)
  WHERE is_published = true;

COMMENT ON TABLE ath_recruiting_profiles IS
  'Per-student athletic recruiting profile. UNIQUE(student_id) caps each athlete at one profile. Student-owned — the Step 4 RecruitingService refuses non-self non-admin non-coach writes. is_published gates whether the profile surfaces to college recruiters and to the partial INDEX used by the public-marketplace browse path. Multi-column published_chk keeps published_at populated only when is_published is true. gpa is a denormalised snapshot from rpt_student_academic_summary refreshed at publication time, not maintained live — the gpa_snapshot_at timestamp records when the snapshot was taken.';

COMMENT ON COLUMN ath_recruiting_profiles.student_id IS
  'Soft FK to sis_students(id) per ADR-001/020. The student who owns this profile.';

COMMENT ON COLUMN ath_recruiting_profiles.gpa IS
  'Snapshot from Cycle 29 rpt_student_academic_summary, refreshed at publication time. NUMERIC(4,3) — supports a 4-point scale with millidigit precision (e.g. 3.872) which covers the common 4.0 + weighted-AP scales without lossy rounding. gpa_snapshot_at records the read time so reviewers can age-out stale values.';

CREATE TABLE IF NOT EXISTS ath_recruiting_interests (
    id UUID PRIMARY KEY,
    recruiting_profile_id UUID NOT NULL REFERENCES ath_recruiting_profiles(id) ON DELETE CASCADE,
    college_name TEXT NOT NULL,
    contact_name TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    interest_level TEXT NOT NULL DEFAULT 'EXPLORING',
    last_contact_date DATE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ath_recruiting_interests_level_chk
      CHECK (interest_level IN ('EXPLORING','INTERESTED','APPLIED','COMMITTED')),
    CONSTRAINT ath_recruiting_interests_college_chk
      CHECK (length(trim(college_name)) > 0)
);

CREATE INDEX IF NOT EXISTS ath_recruiting_interests_profile_idx
  ON ath_recruiting_interests(recruiting_profile_id, interest_level);

COMMENT ON TABLE ath_recruiting_interests IS
  'Per-(profile, college) interest tracker. interest_level 4-value CHECK EXPLORING, INTERESTED, APPLIED, COMMITTED drives the funnel view. Multiple colleges per profile expected. CASCADE on parent profile delete since interest rows are meaningless without their profile. INDEX on (profile_id, interest_level) drives the per-profile interest list grouped by level.';
