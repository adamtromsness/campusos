/*
 * 062_grp_announcements_events.sql — Cycle 18 Step 2.
 *
 * M103 Groups and Communities domain 2: group-scoped announcements
 * with pinning + read receipts, and group events with RSVP / max
 * attendees / public-or-private visibility. The grp_event_rsvps
 * link table lands here too — the plan's 7-table count omits it,
 * but we ship it because per-RSVP audit is a real requirement.
 */

CREATE TABLE IF NOT EXISTS grp_announcements (
  id              UUID PRIMARY KEY,
  group_id        UUID NOT NULL,
  author_id       UUID NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  pinned          BOOLEAN NOT NULL DEFAULT false,
  attachments     JSONB,
  publish_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT grp_announcements_window_chk CHECK (
    expires_at IS NULL OR expires_at > publish_at
  ),
  CONSTRAINT grp_announcements_group_fk FOREIGN KEY (group_id)
    REFERENCES grp_groups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS grp_announcements_feed_idx
  ON grp_announcements (group_id, publish_at DESC);
CREATE INDEX IF NOT EXISTS grp_announcements_pinned_idx
  ON grp_announcements (group_id, pinned)
  WHERE pinned = true;

COMMENT ON TABLE grp_announcements IS
  'Group-scoped announcement. author_id is a soft FK to platform.iam_person — the Step 5 service validates the author is OWNER or ADMIN of the group at the application layer. CASCADE on group delete drops the announcement (read receipts cascade through this table).';

CREATE TABLE IF NOT EXISTS grp_announcement_reads (
  id                  UUID PRIMARY KEY,
  announcement_id     UUID NOT NULL,
  reader_id           UUID NOT NULL,
  read_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT grp_reads_announcement_fk FOREIGN KEY (announcement_id)
    REFERENCES grp_announcements(id) ON DELETE CASCADE,
  CONSTRAINT grp_reads_uq UNIQUE (announcement_id, reader_id)
);

COMMENT ON TABLE grp_announcement_reads IS
  'Append-only read receipts. UNIQUE(announcement_id, reader_id) so a reader counts at most once per announcement. CASCADE on parent announcement.';

CREATE TABLE IF NOT EXISTS grp_events (
  id                  UUID PRIMARY KEY,
  group_id            UUID NOT NULL,
  created_by          UUID NOT NULL,
  title               TEXT NOT NULL,
  description         TEXT,
  location            TEXT,
  starts_at           TIMESTAMPTZ NOT NULL,
  ends_at             TIMESTAMPTZ,
  event_type          TEXT NOT NULL,
  requires_rsvp       BOOLEAN NOT NULL DEFAULT false,
  rsvp_deadline       TIMESTAMPTZ,
  max_attendees       INT,
  is_public           BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT grp_events_type_chk CHECK (
    event_type IN ('PRACTICE', 'MATCH', 'MEETING', 'SOCIAL', 'PERFORMANCE', 'COMPETITION', 'OTHER')
  ),
  CONSTRAINT grp_events_dates_chk CHECK (ends_at IS NULL OR ends_at >= starts_at),
  CONSTRAINT grp_events_rsvp_window_chk CHECK (
    rsvp_deadline IS NULL OR rsvp_deadline <= starts_at
  ),
  CONSTRAINT grp_events_max_chk CHECK (max_attendees IS NULL OR max_attendees > 0),
  CONSTRAINT grp_events_group_fk FOREIGN KEY (group_id)
    REFERENCES grp_groups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS grp_events_feed_idx
  ON grp_events (group_id, starts_at DESC);

COMMENT ON TABLE grp_events IS
  'Group-scoped event. is_public=true makes the event visible to non-members. event_type drives Step 7 UI chip styling. rsvp_window_chk keeps the RSVP deadline before the event start, and max_chk keeps the cap positive.';

CREATE TABLE IF NOT EXISTS grp_event_rsvps (
  id              UUID PRIMARY KEY,
  event_id        UUID NOT NULL,
  responder_id    UUID NOT NULL,
  status          TEXT NOT NULL,
  responded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT grp_rsvp_status_chk CHECK (status IN ('GOING', 'NOT_GOING', 'MAYBE')),
  CONSTRAINT grp_rsvp_event_fk FOREIGN KEY (event_id)
    REFERENCES grp_events(id) ON DELETE CASCADE,
  CONSTRAINT grp_rsvp_uq UNIQUE (event_id, responder_id)
);

COMMENT ON TABLE grp_event_rsvps IS
  'Per-event RSVP. UNIQUE(event_id, responder_id) so a respondent has exactly one RSVP per event — PATCH replaces. The Step 5 service validates max_attendees + rsvp_deadline at the application layer before insert / update.';
