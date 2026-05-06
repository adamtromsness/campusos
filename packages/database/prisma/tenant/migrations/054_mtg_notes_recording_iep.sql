/* 054_mtg_notes_recording_iep.sql
 * Cycle 15 Step 2 — M41 Meetings. Agenda items, meeting notes with the
 * two-layer parent-visibility gate, action items with cross-persona
 * assignees, recording metadata with consent tracking, and IEP meeting
 * records linking to Cycle 10 health plans.
 *
 * Tables (6):
 *   mtg_agenda_items         Per-meeting ordered agenda.
 *   mtg_meeting_notes        Notes with parent-visibility KEYSTONE.
 *   mtg_action_items         Cross-persona assignees with completed_chk lockstep.
 *   mtg_recordings           Recording metadata + consent_confirmed flag.
 *   mtg_recording_consents   Per-(recording, participant) consent rows.
 *   mtg_iep_meeting_records  CROSS-CYCLE INTEGRATION KEYSTONE.
 *
 * Soft refs per ADR-001 / ADR-020. presenter_id, approved_by, assignee_id,
 * created_by, recorded_by, participant_id, student_id, iep_plan_id are
 * all soft to platform / Cycle 10 tenant tables.
 *
 * Cross-cycle integration. mtg_iep_meeting_records.iep_plan_id is a soft
 * ref to Cycle 10 hlth_iep_plans(id). Cycle 11 svc_mtss_team_meetings has
 * a soft meeting_id forward-compat column that this migration enables to
 * resolve to real mtg_meetings(id) rows.
 *
 * Splitter discipline. This file is splitter-clean per the
 * Cycles 4-14 unbroken streak. Comment text contains no
 * statement-terminator characters.
 */

CREATE TABLE IF NOT EXISTS mtg_agenda_items (
  id               UUID PRIMARY KEY,
  meeting_id       UUID NOT NULL REFERENCES mtg_meetings(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT,
  presenter_id     UUID,
  duration_minutes INT,
  sort_order       INT NOT NULL DEFAULT 0,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mtg_agenda_items_duration_chk CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  CONSTRAINT mtg_agenda_items_sort_chk CHECK (sort_order >= 0)
);

CREATE INDEX IF NOT EXISTS mtg_agenda_items_meeting_sort_idx
  ON mtg_agenda_items (meeting_id, sort_order);

CREATE TABLE IF NOT EXISTS mtg_meeting_notes (
  id                     UUID PRIMARY KEY,
  meeting_id             UUID NOT NULL REFERENCES mtg_meetings(id) ON DELETE CASCADE,
  notes_text             TEXT,
  is_approved            BOOLEAN NOT NULL DEFAULT false,
  approved_by            UUID,
  approved_at            TIMESTAMPTZ,
  is_parent_visible      BOOLEAN NOT NULL DEFAULT false,
  parent_visible_summary TEXT,
  created_by             UUID,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mtg_meeting_notes_meeting_uq UNIQUE (meeting_id),
  CONSTRAINT mtg_meeting_notes_approved_chk CHECK (
    (is_approved = false AND approved_by IS NULL AND approved_at IS NULL)
    OR
    (is_approved = true AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
);

COMMENT ON TABLE mtg_meeting_notes IS
  'Cycle 15 Step 2. PARENT-VISIBILITY KEYSTONE. Two-layer gate. Parents see notes only when BOTH is_parent_visible=true AND is_approved=true. They see parent_visible_summary when populated, otherwise full notes_text. The Step 5 MeetingNotesService applies the gate at read time. The multi-column approved_chk keystone keeps the trio (is_approved, approved_by, approved_at) in lockstep so the schema never sees a half-approved row.';

CREATE TABLE IF NOT EXISTS mtg_action_items (
  id           UUID PRIMARY KEY,
  meeting_id   UUID NOT NULL REFERENCES mtg_meetings(id) ON DELETE CASCADE,
  assignee_id  UUID NOT NULL,
  description  TEXT NOT NULL,
  due_date     DATE,
  status       TEXT NOT NULL DEFAULT 'OPEN',
  completed_at TIMESTAMPTZ,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mtg_action_items_status_chk
    CHECK (status IN ('OPEN','IN_PROGRESS','DONE','CANCELLED')),
  CONSTRAINT mtg_action_items_completed_chk CHECK (
    (status IN ('OPEN','IN_PROGRESS') AND completed_at IS NULL)
    OR
    (status IN ('DONE','CANCELLED') AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS mtg_action_items_meeting_idx
  ON mtg_action_items (meeting_id);

CREATE INDEX IF NOT EXISTS mtg_action_items_assignee_status_idx
  ON mtg_action_items (assignee_id, status);

COMMENT ON TABLE mtg_action_items IS
  'Cycle 15 Step 2. Cross-persona assignees. assignee_id is a soft ref to platform.platform_users covering both staff and parent assignees. Parents can see and update action items assigned to them per the Step 5 row scope.';

CREATE TABLE IF NOT EXISTS mtg_recordings (
  id                UUID PRIMARY KEY,
  meeting_id        UUID NOT NULL REFERENCES mtg_meetings(id) ON DELETE CASCADE,
  s3_key            TEXT,
  duration_seconds  INT,
  file_size_bytes   BIGINT,
  status            TEXT NOT NULL DEFAULT 'PROCESSING',
  consent_confirmed BOOLEAN NOT NULL DEFAULT false,
  created_by        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mtg_recordings_meeting_uq UNIQUE (meeting_id),
  CONSTRAINT mtg_recordings_status_chk
    CHECK (status IN ('PROCESSING','AVAILABLE','FAILED')),
  CONSTRAINT mtg_recordings_duration_chk
    CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  CONSTRAINT mtg_recordings_size_chk
    CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0)
);

CREATE TABLE IF NOT EXISTS mtg_recording_consents (
  id             UUID PRIMARY KEY,
  recording_id   UUID NOT NULL REFERENCES mtg_recordings(id) ON DELETE CASCADE,
  participant_id UUID NOT NULL,
  consent_given  BOOLEAN NOT NULL,
  consented_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes          TEXT,
  CONSTRAINT mtg_recording_consents_unique UNIQUE (recording_id, participant_id)
);

CREATE INDEX IF NOT EXISTS mtg_recording_consents_recording_idx
  ON mtg_recording_consents (recording_id);

COMMENT ON TABLE mtg_recording_consents IS
  'Cycle 15 Step 2. Per-(recording, participant) consent row. The Step 5 RecordingService flips mtg_recordings.consent_confirmed=true once every active meeting participant has a consent_given=true row. Decline rows count as participation but block consent_confirmed.';

CREATE TABLE IF NOT EXISTS mtg_iep_meeting_records (
  id                UUID PRIMARY KEY,
  meeting_id        UUID NOT NULL REFERENCES mtg_meetings(id) ON DELETE CASCADE,
  student_id        UUID NOT NULL,
  iep_plan_id       UUID,
  attendee_roles    JSONB NOT NULL DEFAULT '[]'::jsonb,
  outcomes_summary  TEXT,
  next_review_date  DATE,
  recorded_by       UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mtg_iep_meeting_records_meeting_uq UNIQUE (meeting_id)
);

CREATE INDEX IF NOT EXISTS mtg_iep_meeting_records_student_idx
  ON mtg_iep_meeting_records (student_id);

CREATE INDEX IF NOT EXISTS mtg_iep_meeting_records_plan_idx
  ON mtg_iep_meeting_records (iep_plan_id) WHERE iep_plan_id IS NOT NULL;

COMMENT ON TABLE mtg_iep_meeting_records IS
  'Cycle 15 Step 2. CROSS-CYCLE INTEGRATION KEYSTONE. iep_plan_id is a soft ref to Cycle 10 hlth_iep_plans(id) per ADR-001. Resolves Cycle 11 svc_mtss_team_meetings.meeting_id forward-compat soft FK so MTSS team meetings can now reference real mtg_meetings(id) rows. attendee_roles JSONB carries a structured array of person plus role plus name for IEP team minutes that survive personnel changes.';
