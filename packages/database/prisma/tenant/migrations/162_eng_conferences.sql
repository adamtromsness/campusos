/*
 * 162_eng_conferences.sql — P2-24a Step 1.
 *
 * Parent Engagement Module (M100) — conference scheduling tables.
 *
 *   eng_conference_events    Per-school conference week event. 4 value
 *                            status CHECK DRAFT / BOOKING_OPEN /
 *                            IN_PROGRESS / COMPLETED. ConferenceStatusWorker
 *                            auto-transitions DRAFT to BOOKING_OPEN when
 *                            booking_opens_at passes and emits
 *                            eng.conference.booking_open for parent
 *                            notification. created_by soft to
 *                            platform.platform_users per ADR-001/020.
 *
 *   eng_conference_slots     Per-teacher availability slot inside a
 *                            conference event. 3 value status CHECK
 *                            AVAILABLE / BOOKED / BLOCKED. max_bookings
 *                            defaults to 1 for individual PTC and can be
 *                            larger for group sessions. UNIQUE on
 *                            (conference_event_id, teacher_id, slot_date,
 *                            start_time) prevents a teacher from
 *                            publishing two slots at the same time.
 *
 *                            ATOMIC BOOKING — the canonical lock-free
 *                            booking pattern is
 *                            UPDATE eng_conference_slots
 *                              SET status = 'BOOKED', updated_at = now()
 *                            WHERE id = $1::uuid
 *                              AND status = 'AVAILABLE'
 *                              AND school_id = $2::uuid
 *                            RETURNING id.
 *                            Zero rows returned means the slot was
 *                            already booked / blocked / cancelled — the
 *                            service translates that to 409 Conflict.
 *                            teacher_id is a real DB enforced FK to
 *                            hr_employees(id) NO ACTION because dropping
 *                            a staff member with booked PTC slots would
 *                            silently orphan parent commitments.
 *
 *   eng_conference_bookings  One booking row per (slot, parent, student)
 *                            triple. UNIQUE on the triple prevents a
 *                            single parent from booking the same slot
 *                            twice for the same child. Multi column
 *                            cancelled_chk pins cancelled_at populated
 *                            when status implies CANCELLED via NULL
 *                            check semantics (kept simple as a multi
 *                            column lockstep). attended is nullable
 *                            BOOLEAN — null while pending, true / false
 *                            after the slot date passes. parent_feedback_rating
 *                            CHECK 1..5 captures the parents post-meeting
 *                            satisfaction. follow_up_actions JSONB array
 *                            of {description, due_date, status} tracked
 *                            in service-layer notes only — no schema
 *                            constraints on the shape beyond array type.
 *
 * FK summary (intra tenant only, 0 cross schema FK constraints):
 *   eng_conference_slots.conference_event_id    eng_conference_events(id) CASCADE
 *   eng_conference_slots.teacher_id             hr_employees(id) NO ACTION
 *   eng_conference_bookings.slot_id             eng_conference_slots(id) NO ACTION
 *
 * parent_id (platform_users), student_id (sis_students), created_by
 * (platform_users) are soft per ADR-001/020.
 *
 * Splitter discipline — no semicolons inside string literals, default
 * expressions, COMMENT bodies, CHECK predicates, or block comments.
 * Idempotent — safe to re-run.
 */


CREATE TABLE IF NOT EXISTS eng_conference_events (
  id                              UUID PRIMARY KEY,
  school_id                       UUID NOT NULL,
  title                           TEXT NOT NULL,
  description                     TEXT,
  start_date                      DATE NOT NULL,
  end_date                        DATE NOT NULL,
  booking_opens_at                TIMESTAMPTZ NOT NULL,
  booking_closes_at               TIMESTAMPTZ NOT NULL,
  default_slot_duration_minutes   INT NOT NULL DEFAULT 10,
  default_break_minutes           INT NOT NULL DEFAULT 5,
  status                          TEXT NOT NULL DEFAULT 'DRAFT',
  created_by                      UUID NOT NULL,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT eng_conference_events_status_chk CHECK (
    status IN ('DRAFT', 'BOOKING_OPEN', 'IN_PROGRESS', 'COMPLETED')
  ),
  CONSTRAINT eng_conference_events_title_chk CHECK (length(trim(title)) > 0),
  CONSTRAINT eng_conference_events_dates_chk CHECK (end_date >= start_date),
  CONSTRAINT eng_conference_events_window_chk CHECK (
    booking_closes_at > booking_opens_at
  ),
  CONSTRAINT eng_conference_events_duration_chk CHECK (
    default_slot_duration_minutes > 0 AND default_slot_duration_minutes <= 240
  ),
  CONSTRAINT eng_conference_events_break_chk CHECK (default_break_minutes >= 0)
);

CREATE INDEX IF NOT EXISTS eng_conference_events_school_status_idx
  ON eng_conference_events (school_id, status);

CREATE INDEX IF NOT EXISTS eng_conference_events_school_dates_idx
  ON eng_conference_events (school_id, start_date DESC);

CREATE INDEX IF NOT EXISTS eng_conference_events_booking_open_sweep_idx
  ON eng_conference_events (booking_opens_at, status)
  WHERE status = 'DRAFT';

COMMENT ON TABLE eng_conference_events IS
  'P2-24 — Per-school parent-teacher conference event (Fall PTC Week / Spring PTC Week / etc.). 4 value status CHECK DRAFT / BOOKING_OPEN / IN_PROGRESS / COMPLETED. ConferenceStatusWorker auto-transitions DRAFT to BOOKING_OPEN when booking_opens_at passes and emits eng.conference.booking_open. created_by soft to platform.platform_users per ADR-001/020.';


CREATE TABLE IF NOT EXISTS eng_conference_slots (
  id                              UUID PRIMARY KEY,
  conference_event_id             UUID NOT NULL,
  school_id                       UUID NOT NULL,
  teacher_id                      UUID NOT NULL,
  slot_date                       DATE NOT NULL,
  start_time                      TIME NOT NULL,
  end_time                        TIME NOT NULL,
  location                        TEXT,
  meeting_url                     TEXT,
  status                          TEXT NOT NULL DEFAULT 'AVAILABLE',
  max_bookings                    INT NOT NULL DEFAULT 1,
  current_bookings                INT NOT NULL DEFAULT 0,
  notes                           TEXT,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT eng_conference_slots_status_chk CHECK (
    status IN ('AVAILABLE', 'BOOKED', 'BLOCKED')
  ),
  CONSTRAINT eng_conference_slots_times_chk CHECK (end_time > start_time),
  CONSTRAINT eng_conference_slots_max_chk CHECK (max_bookings >= 1),
  CONSTRAINT eng_conference_slots_current_chk CHECK (
    current_bookings >= 0 AND current_bookings <= max_bookings
  ),
  CONSTRAINT eng_conference_slots_event_fkey FOREIGN KEY (conference_event_id)
    REFERENCES eng_conference_events(id) ON DELETE CASCADE,
  CONSTRAINT eng_conference_slots_teacher_fkey FOREIGN KEY (teacher_id)
    REFERENCES hr_employees(id) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS eng_conference_slots_event_teacher_slot_uq
  ON eng_conference_slots (conference_event_id, teacher_id, slot_date, start_time);

CREATE INDEX IF NOT EXISTS eng_conference_slots_event_teacher_idx
  ON eng_conference_slots (conference_event_id, teacher_id, slot_date, start_time);

CREATE INDEX IF NOT EXISTS eng_conference_slots_school_status_idx
  ON eng_conference_slots (school_id, status);

CREATE INDEX IF NOT EXISTS eng_conference_slots_available_idx
  ON eng_conference_slots (conference_event_id, teacher_id, slot_date)
  WHERE status = 'AVAILABLE';

COMMENT ON TABLE eng_conference_slots IS
  'P2-24 — Per-teacher availability slot inside a conference event. 3 value status CHECK AVAILABLE / BOOKED / BLOCKED. ATOMIC BOOKING — UPDATE SET status=BOOKED WHERE id matches AND status=AVAILABLE and zero rows returned means 409 already booked. UNIQUE(conference_event_id, teacher_id, slot_date, start_time) prevents publishing two slots at the same minute. teacher_id is a real DB FK to hr_employees(id) NO ACTION — refuse to drop staff with active PTC commitments. max_bookings defaults to 1 for individual PTC and can be larger for group sessions where current_bookings tracks the running count.';


CREATE TABLE IF NOT EXISTS eng_conference_bookings (
  id                              UUID PRIMARY KEY,
  slot_id                         UUID NOT NULL,
  school_id                       UUID NOT NULL,
  parent_id                       UUID NOT NULL,
  student_id                      UUID NOT NULL,
  booked_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at                    TIMESTAMPTZ,
  cancelled_by                    UUID,
  cancellation_reason             TEXT,
  attended                        BOOLEAN,
  conference_notes                TEXT,
  follow_up_actions               JSONB,
  parent_feedback_rating          INT,
  parent_feedback_comments        TEXT,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT eng_conference_bookings_rating_chk CHECK (
    parent_feedback_rating IS NULL OR (parent_feedback_rating >= 1 AND parent_feedback_rating <= 5)
  ),
  CONSTRAINT eng_conference_bookings_cancelled_chk CHECK (
    (cancelled_at IS NULL AND cancelled_by IS NULL)
    OR
    (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
  ),
  CONSTRAINT eng_conference_bookings_follow_up_array_chk CHECK (
    follow_up_actions IS NULL OR jsonb_typeof(follow_up_actions) = 'array'
  ),
  CONSTRAINT eng_conference_bookings_slot_fkey FOREIGN KEY (slot_id)
    REFERENCES eng_conference_slots(id) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS eng_conference_bookings_slot_parent_student_uq
  ON eng_conference_bookings (slot_id, parent_id, student_id)
  WHERE cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS eng_conference_bookings_parent_idx
  ON eng_conference_bookings (parent_id, booked_at DESC);

CREATE INDEX IF NOT EXISTS eng_conference_bookings_school_idx
  ON eng_conference_bookings (school_id, booked_at DESC);

CREATE INDEX IF NOT EXISTS eng_conference_bookings_student_idx
  ON eng_conference_bookings (student_id, booked_at DESC);

COMMENT ON TABLE eng_conference_bookings IS
  'P2-24 — One booking row per (slot, parent, student) triple. Partial UNIQUE(slot_id, parent_id, student_id) WHERE cancelled_at IS NULL prevents a single parent from booking the same slot twice for the same child while preserving cancelled rows in the audit history. attended BOOLEAN is null until the slot date passes, then teacher marks true / false. parent_feedback_rating CHECK 1..5 captures post-meeting satisfaction. follow_up_actions is a JSONB array of {description, due_date, status} sub-tasks tracked at the service layer. parent_id, student_id, cancelled_by are soft refs per ADR-001/020.';
