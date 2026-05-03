/* 023_sch_calendar_event_rsvps.sql
 * Phase 2 polish — calendar event RSVPs.
 *
 * One new tenant base table sch_calendar_event_rsvps. Lets a parent or staff
 * member respond GOING, TENTATIVE, or NOT_GOING to a calendar event. The
 * Calendar UI uses this both to render RSVP buttons on the event detail
 * Modal and to back the "Show only events my children are involved in"
 * filter on the parent calendar view.
 *
 * person_id is a soft cross-schema ref to platform.iam_person per
 * ADR-001 and ADR-020. UNIQUE(calendar_event_id, person_id) so re-RSVP
 * upserts a single row per (event, person) pair. CASCADE on the calendar
 * event because RSVPs without their parent event are meaningless.
 *
 * No CHECK on response_at — it is set by the service to now() at every
 * upsert. The 3-value response CHECK is the canonical lifecycle.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency. Block
 * comment header, no semicolons inside any string literal or comment per
 * the documented splitter trap from Cycles 4 through 6.
 */

CREATE TABLE IF NOT EXISTS sch_calendar_event_rsvps (
  id                 UUID         PRIMARY KEY,
  calendar_event_id  UUID         NOT NULL REFERENCES sch_calendar_events(id) ON DELETE CASCADE,
  person_id          UUID         NOT NULL,
  response           TEXT         NOT NULL,
  responded_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT sch_calendar_event_rsvps_response_chk
    CHECK (response IN ('GOING', 'TENTATIVE', 'NOT_GOING'))
);

CREATE UNIQUE INDEX IF NOT EXISTS sch_calendar_event_rsvps_event_person_uq
  ON sch_calendar_event_rsvps (calendar_event_id, person_id);

CREATE INDEX IF NOT EXISTS sch_calendar_event_rsvps_person_idx
  ON sch_calendar_event_rsvps (person_id);

COMMENT ON TABLE sch_calendar_event_rsvps IS
  'Per-(event, person) RSVP responses. Soft FK person_id to platform.iam_person per ADR-001 and ADR-020. Used by the Calendar UI for RSVP buttons and the my-children filter on the parent calendar.';

COMMENT ON COLUMN sch_calendar_event_rsvps.response IS
  'One of GOING, TENTATIVE, NOT_GOING. UI defaults to TENTATIVE on first response.';
