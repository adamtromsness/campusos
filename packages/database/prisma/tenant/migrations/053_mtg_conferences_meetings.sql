/* 053_mtg_conferences_meetings.sql
 * Cycle 15 Step 1 — M41 Meetings. Conference event containers,
 * configurable meeting types, individual meetings with participant
 * tracking, and bookable time slots for parent-teacher conferences.
 *
 * Tables (5):
 *   mtg_conference_events       Top-level container for a conference week.
 *   mtg_meeting_types           Per-school catalogue of meeting kinds.
 *   mtg_meetings                Individual meeting instance.
 *   mtg_meeting_participants    Per-(meeting, participant) row with role + attendance.
 *   mtg_meeting_slots           Bookable time slots — the PTC keystone.
 *
 * Soft refs per ADR-001 / ADR-020. school_id, organiser_id, participant_id,
 * booked_by, presenter_id, created_by all reference platform.platform_users
 * or platform.schools and have no DB FK.
 *
 * DB-enforced FKs introduced this migration. NO ACTION on
 * mtg_meetings.meeting_type_id audit-preserves a retired type. SET NULL on
 * mtg_meetings.conference_event_id keeps standalone meetings alive when
 * the parent conference is removed. CASCADE on participants and slots
 * since they have no meaning without their parent meeting.
 *
 * Splitter discipline. This file is splitter-clean per the
 * Cycles 4-14 unbroken streak. Comment text contains no
 * statement-terminator characters.
 */

CREATE TABLE IF NOT EXISTS mtg_conference_events (
  id              UUID PRIMARY KEY,
  school_id       UUID NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  conference_type TEXT NOT NULL,
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'SCHEDULED',
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mtg_conference_events_type_chk
    CHECK (conference_type IN ('PARENT_TEACHER','STAFF','BOARD','IEP','TRAINING')),
  CONSTRAINT mtg_conference_events_status_chk
    CHECK (status IN ('SCHEDULED','ACTIVE','COMPLETED','CANCELLED')),
  CONSTRAINT mtg_conference_events_dates_chk CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS mtg_conference_events_school_recent_idx
  ON mtg_conference_events (school_id, start_date DESC);

COMMENT ON TABLE mtg_conference_events IS
  'Cycle 15 Step 1. Top-level container for a conference week such as Spring Parent-Teacher Conferences. Individual meetings and slots hang under it via mtg_meetings.conference_event_id.';

CREATE TABLE IF NOT EXISTS mtg_meeting_types (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  name                     TEXT NOT NULL,
  description              TEXT,
  default_duration_minutes INT NOT NULL DEFAULT 30,
  is_video                 BOOLEAN NOT NULL DEFAULT false,
  is_active                BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mtg_meeting_types_school_name_uq UNIQUE (school_id, name),
  CONSTRAINT mtg_meeting_types_duration_chk CHECK (default_duration_minutes > 0)
);

CREATE INDEX IF NOT EXISTS mtg_meeting_types_school_active_idx
  ON mtg_meeting_types (school_id, is_active);

CREATE TABLE IF NOT EXISTS mtg_meetings (
  id                  UUID PRIMARY KEY,
  school_id           UUID NOT NULL,
  meeting_type_id     UUID NOT NULL REFERENCES mtg_meeting_types(id) ON DELETE NO ACTION,
  conference_event_id UUID REFERENCES mtg_conference_events(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  description         TEXT,
  scheduled_at        TIMESTAMPTZ NOT NULL,
  duration_minutes    INT NOT NULL DEFAULT 30,
  meeting_url         TEXT,
  status              TEXT NOT NULL DEFAULT 'SCHEDULED',
  organiser_id        UUID NOT NULL,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mtg_meetings_status_chk
    CHECK (status IN ('SCHEDULED','IN_PROGRESS','COMPLETED','CANCELLED')),
  CONSTRAINT mtg_meetings_duration_chk CHECK (duration_minutes > 0)
);

CREATE INDEX IF NOT EXISTS mtg_meetings_school_recent_idx
  ON mtg_meetings (school_id, scheduled_at DESC);

CREATE INDEX IF NOT EXISTS mtg_meetings_organiser_idx
  ON mtg_meetings (organiser_id, scheduled_at DESC);

CREATE INDEX IF NOT EXISTS mtg_meetings_conference_idx
  ON mtg_meetings (conference_event_id) WHERE conference_event_id IS NOT NULL;

COMMENT ON TABLE mtg_meetings IS
  'Cycle 15 Step 1. Individual meeting instance. May be standalone or hang under a mtg_conference_events row. organiser_id is a soft ref to platform.platform_users per ADR-001.';

CREATE TABLE IF NOT EXISTS mtg_meeting_participants (
  id             UUID PRIMARY KEY,
  meeting_id     UUID NOT NULL REFERENCES mtg_meetings(id) ON DELETE CASCADE,
  participant_id UUID NOT NULL,
  role           TEXT NOT NULL DEFAULT 'ATTENDEE',
  attended       BOOLEAN NOT NULL DEFAULT false,
  join_at        TIMESTAMPTZ,
  leave_at       TIMESTAMPTZ,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mtg_meeting_participants_role_chk
    CHECK (role IN ('HOST','PRESENTER','ATTENDEE','OBSERVER')),
  CONSTRAINT mtg_meeting_participants_unique UNIQUE (meeting_id, participant_id)
);

CREATE INDEX IF NOT EXISTS mtg_meeting_participants_lookup_idx
  ON mtg_meeting_participants (participant_id, meeting_id);

CREATE TABLE IF NOT EXISTS mtg_meeting_slots (
  id          UUID PRIMARY KEY,
  meeting_id  UUID NOT NULL REFERENCES mtg_meetings(id) ON DELETE CASCADE,
  start_time  TIMESTAMPTZ NOT NULL,
  end_time    TIMESTAMPTZ NOT NULL,
  is_booked   BOOLEAN NOT NULL DEFAULT false,
  booked_by   UUID,
  booked_at   TIMESTAMPTZ,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mtg_meeting_slots_window_chk CHECK (end_time > start_time),
  CONSTRAINT mtg_meeting_slots_booked_chk CHECK (
    (is_booked = false AND booked_by IS NULL AND booked_at IS NULL)
    OR
    (is_booked = true AND booked_by IS NOT NULL AND booked_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS mtg_meeting_slots_meeting_start_idx
  ON mtg_meeting_slots (meeting_id, start_time);

CREATE INDEX IF NOT EXISTS mtg_meeting_slots_available_idx
  ON mtg_meeting_slots (meeting_id) WHERE is_booked = false;

COMMENT ON TABLE mtg_meeting_slots IS
  'Cycle 15 Step 1. PTC BOOKING KEYSTONE. Bookable time slots that hang under a teacher-availability meeting in the parent-teacher conference flow. The Step 4 SlotService.book uses SELECT FOR UPDATE on the row inside executeInTenantTransaction to prevent two parents booking the same slot in a race. The multi-column booked_chk keystone keeps (is_booked, booked_by, booked_at) in lockstep so the schema never sees a half-booked row.';
