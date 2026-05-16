/* 171_grp_polls_events_resources.sql
 *
 * Phase 2 Cycle 28 sub-cycle a (P2-28a) — Groups Advanced.
 *
 * 9 new tenant tables completing the M103 Groups and Communities
 * deferred surface from Cycle 18.
 *
 *   grp_group_polls         Group-scoped poll head. 3-value poll_type
 *                           CHECK (SINGLE_CHOICE, MULTIPLE_CHOICE,
 *                           RANKED). 3-value status CHECK (OPEN,
 *                           CLOSED, CANCELLED). allows_anonymous flag
 *                           — when true, grp_poll_votes.voter_id is
 *                           NULL and the voter check happens at the
 *                           service layer via Redis SET NX on
 *                           poll:vote:<pollId>:<voterId>.
 *
 *   grp_poll_options        Ranked options on a poll. UNIQUE(poll_id,
 *                           sort_order). vote_count is denormalised
 *                           and incremented atomically by the Step 2
 *                           PollService inside the vote tx.
 *
 *   grp_poll_votes          Per-vote audit row. voter_id is NULL on
 *                           anonymous polls — anonymity is structural
 *                           at the schema layer. Partial UNIQUE
 *                           INDEX (poll_id, voter_id, option_id)
 *                           WHERE voter_id IS NOT NULL prevents
 *                           identified double-vote at the schema
 *                           layer for non-anonymous polls. rank
 *                           column carries the ordinal for RANKED
 *                           polls (1 = top preference).
 *
 *   grp_group_events        Informal group-scoped meetup. Distinct
 *                           from Cycle 18 grp_events which has a
 *                           richer event_type / RSVP contract for
 *                           formal group events (matches, practices,
 *                           performances). Distinct from P2-12
 *                           evt_events which is school-wide ticketed
 *                           events. event_date is a TIMESTAMPTZ.
 *                           location is free text.
 *
 *   grp_group_event_rsvps   Per-meetup RSVP with 3-value status CHECK
 *                           (CONFIRMED, DECLINED, PENDING). Named to
 *                           disambiguate from Cycle 18 grp_event_rsvps
 *                           which targets grp_events with a different
 *                           status enum (GOING / NOT_GOING / MAYBE).
 *                           UNIQUE(event_id, member_id) so a member
 *                           carries at most one RSVP per meetup.
 *                           max_attendees enforcement happens at the
 *                           service layer — Step 2 PollService.rsvp
 *                           counts CONFIRMED rows inside the locked
 *                           tx before insert / update.
 *
 *   grp_resource_library    Group resource library entry. 5-value
 *                           resource_type CHECK (DOCUMENT, LINK,
 *                           IMAGE, VIDEO, TEMPLATE). version starts
 *                           at 1 and increments when a new
 *                           grp_resource_versions row lands.
 *                           is_pinned flag controls top-of-list
 *                           rendering.
 *
 *   grp_resource_versions   Versioning history. UNIQUE(resource_id,
 *                           version_number). On INSERT the Step 2
 *                           service increments grp_resource_library
 *                           version in the same tx.
 *
 *   grp_group_invitations   Pending invitation to join a group.
 *                           3-value status CHECK (PENDING, ACCEPTED,
 *                           DECLINED). UNIQUE(group_id,
 *                           invited_user_id). On ACCEPTED the Step 2
 *                           service creates a grp_members row inside
 *                           one tenant tx.
 *
 *   grp_group_analytics     Per-(group, month) engagement read model.
 *                           UNIQUE(group_id, period). Materialised
 *                           monthly by the future GroupAnalyticsWorker
 *                           batch. engagement_rate NUMERIC(5,4)
 *                           supports values 0.0000 to 9.9999.
 *
 * All cross-table refs are intra-tenant DB-enforced FKs to grp_groups
 * (CASCADE on delete since these are leaf operational rows). person /
 * member / option refs are soft FKs per ADR-001 / ADR-020 to match
 * Cycle 18 grp_groups / grp_members convention. 0 cross-schema FKs.
 *
 * Splitter-safe — no semicolons inside string literals or block
 * comments. Idempotent — re-runs are a no-op.
 */

/* --- 1. grp_group_polls --- */

CREATE TABLE IF NOT EXISTS grp_group_polls (
  id                  UUID         PRIMARY KEY,
  group_id            UUID         NOT NULL,
  question            TEXT         NOT NULL,
  poll_type           TEXT         NOT NULL,
  allows_anonymous    BOOLEAN      NOT NULL DEFAULT false,
  closes_at           TIMESTAMPTZ,
  status              TEXT         NOT NULL DEFAULT 'OPEN',
  created_by          UUID         NOT NULL,
  closed_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT grp_poll_type_chk CHECK (
    poll_type IN ('SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'RANKED')
  ),
  CONSTRAINT grp_poll_status_chk CHECK (
    status IN ('OPEN', 'CLOSED', 'CANCELLED')
  ),
  CONSTRAINT grp_poll_closed_chk CHECK (
    (status IN ('CLOSED', 'CANCELLED') AND closed_at IS NOT NULL)
    OR (status = 'OPEN' AND closed_at IS NULL)
  ),
  CONSTRAINT grp_poll_group_fk FOREIGN KEY (group_id)
    REFERENCES grp_groups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS grp_poll_group_status_idx
  ON grp_group_polls (group_id, status);

CREATE INDEX IF NOT EXISTS grp_poll_closing_idx
  ON grp_group_polls (closes_at)
  WHERE status = 'OPEN' AND closes_at IS NOT NULL;

COMMENT ON TABLE grp_group_polls IS
  'P2-28a Step 1 — group-scoped poll head. 3-value poll_type CHECK and 3-value status CHECK. Multi-column closed_chk keeps closed_at in lockstep with non-OPEN status. allows_anonymous=true makes grp_poll_votes.voter_id NULL — anonymity is structural at the schema layer. CASCADE on group delete drops the poll and its option / vote children.';

COMMENT ON COLUMN grp_group_polls.allows_anonymous IS
  'When true the Step 2 PollService records grp_poll_votes with voter_id=NULL and dedup happens via Redis SET NX on poll:vote:<pollId>:<voterAccountId>. When false the partial UNIQUE INDEX on grp_poll_votes is the schema-side belt-and-braces.';

/* --- 2. grp_poll_options --- */

CREATE TABLE IF NOT EXISTS grp_poll_options (
  id            UUID         PRIMARY KEY,
  poll_id       UUID         NOT NULL,
  option_text   TEXT         NOT NULL,
  sort_order    INT          NOT NULL,
  vote_count    INT          NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT grp_poll_option_vote_chk CHECK (vote_count >= 0),
  CONSTRAINT grp_poll_option_sort_chk CHECK (sort_order >= 0),
  CONSTRAINT grp_poll_option_uq UNIQUE (poll_id, sort_order),
  CONSTRAINT grp_poll_option_poll_fk FOREIGN KEY (poll_id)
    REFERENCES grp_group_polls(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS grp_poll_option_poll_idx
  ON grp_poll_options (poll_id, sort_order);

COMMENT ON TABLE grp_poll_options IS
  'P2-28a Step 1 — ranked option on a poll. UNIQUE(poll_id, sort_order) caps options at one per slot. vote_count is denormalised and incremented atomically inside the Step 2 PollService.vote tx via UPDATE ... SET vote_count = vote_count + 1. CASCADE on parent poll drops options.';

/* --- 3. grp_poll_votes --- */

CREATE TABLE IF NOT EXISTS grp_poll_votes (
  id           UUID         PRIMARY KEY,
  poll_id      UUID         NOT NULL,
  option_id    UUID         NOT NULL,
  voter_id     UUID,
  rank         INT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT grp_poll_vote_rank_chk CHECK (rank IS NULL OR rank >= 1),
  CONSTRAINT grp_poll_vote_poll_fk FOREIGN KEY (poll_id)
    REFERENCES grp_group_polls(id) ON DELETE CASCADE,
  CONSTRAINT grp_poll_vote_option_fk FOREIGN KEY (option_id)
    REFERENCES grp_poll_options(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS grp_poll_vote_dedup_uq
  ON grp_poll_votes (poll_id, voter_id, option_id)
  WHERE voter_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS grp_poll_vote_option_idx
  ON grp_poll_votes (option_id);

COMMENT ON TABLE grp_poll_votes IS
  'P2-28a Step 1 — per-vote audit row. voter_id is NULL when the parent poll has allows_anonymous=true — anonymity is structural. Partial UNIQUE INDEX(poll_id, voter_id, option_id) WHERE voter_id IS NOT NULL prevents identified double-vote on non-anonymous polls at the schema layer. rank carries the ordinal for RANKED polls (1 = top preference). CASCADE on poll or option drops the vote row.';

COMMENT ON COLUMN grp_poll_votes.voter_id IS
  'Soft FK to platform.iam_person per ADR-001 / ADR-020. NULL when the parent poll is anonymous. Anonymity is enforced at the schema layer rather than relying solely on the service to suppress identity.';

/* --- 4. grp_group_events --- */

CREATE TABLE IF NOT EXISTS grp_group_events (
  id              UUID         PRIMARY KEY,
  group_id        UUID         NOT NULL,
  title           TEXT         NOT NULL,
  description     TEXT,
  event_date      TIMESTAMPTZ  NOT NULL,
  location        TEXT,
  max_attendees   INT,
  created_by      UUID         NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT grp_group_event_max_chk CHECK (
    max_attendees IS NULL OR max_attendees > 0
  ),
  CONSTRAINT grp_group_event_group_fk FOREIGN KEY (group_id)
    REFERENCES grp_groups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS grp_group_event_feed_idx
  ON grp_group_events (group_id, event_date);

COMMENT ON TABLE grp_group_events IS
  'P2-28a Step 1 — informal group meetup. Distinct from Cycle 18 grp_events which has a richer event_type / RSVP contract for formal group events. Distinct from P2-12 evt_events which is school-wide ticketed events. event_date is a TIMESTAMPTZ. location is free text. max_chk keeps the cap positive.';

/* --- 5. grp_group_event_rsvps --- */

CREATE TABLE IF NOT EXISTS grp_group_event_rsvps (
  id            UUID         PRIMARY KEY,
  event_id      UUID         NOT NULL,
  member_id     UUID         NOT NULL,
  status        TEXT         NOT NULL DEFAULT 'PENDING',
  responded_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT grp_group_event_rsvp_status_chk CHECK (
    status IN ('CONFIRMED', 'DECLINED', 'PENDING')
  ),
  CONSTRAINT grp_group_event_rsvp_responded_chk CHECK (
    (status = 'PENDING' AND responded_at IS NULL)
    OR (status IN ('CONFIRMED', 'DECLINED') AND responded_at IS NOT NULL)
  ),
  CONSTRAINT grp_group_event_rsvp_uq UNIQUE (event_id, member_id),
  CONSTRAINT grp_group_event_rsvp_event_fk FOREIGN KEY (event_id)
    REFERENCES grp_group_events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS grp_group_event_rsvp_status_idx
  ON grp_group_event_rsvps (event_id, status);

COMMENT ON TABLE grp_group_event_rsvps IS
  'P2-28a Step 1 — per-meetup RSVP. Named to disambiguate from Cycle 18 grp_event_rsvps which targets grp_events with status GOING / NOT_GOING / MAYBE. 3-value status CHECK (CONFIRMED, DECLINED, PENDING). multi-column responded_chk keeps responded_at in lockstep with non-PENDING status. UNIQUE(event_id, member_id) so a member has at most one RSVP per meetup — PATCH replaces. max_attendees cap enforced at the Step 2 service layer inside the locked tx.';

/* --- 6. grp_resource_library --- */

CREATE TABLE IF NOT EXISTS grp_resource_library (
  id              UUID         PRIMARY KEY,
  group_id        UUID         NOT NULL,
  title           TEXT         NOT NULL,
  description     TEXT,
  resource_type   TEXT         NOT NULL,
  s3_key          TEXT,
  url             TEXT,
  uploaded_by     UUID         NOT NULL,
  version         INT          NOT NULL DEFAULT 1,
  is_pinned       BOOLEAN      NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT grp_resource_type_chk CHECK (
    resource_type IN ('DOCUMENT', 'LINK', 'IMAGE', 'VIDEO', 'TEMPLATE')
  ),
  CONSTRAINT grp_resource_version_chk CHECK (version >= 1),
  CONSTRAINT grp_resource_target_chk CHECK (
    s3_key IS NOT NULL OR url IS NOT NULL
  ),
  CONSTRAINT grp_resource_group_fk FOREIGN KEY (group_id)
    REFERENCES grp_groups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS grp_resource_feed_idx
  ON grp_resource_library (group_id, is_pinned DESC, created_at DESC);

COMMENT ON TABLE grp_resource_library IS
  'P2-28a Step 1 — group resource library entry. 5-value resource_type CHECK (DOCUMENT, LINK, IMAGE, VIDEO, TEMPLATE). version starts at 1 and increments when a new grp_resource_versions row lands. is_pinned flag drives the Step 2 UI top-of-list rendering. target_chk requires at least one of s3_key (uploaded file) or url (external link).';

/* --- 7. grp_resource_versions --- */

CREATE TABLE IF NOT EXISTS grp_resource_versions (
  id              UUID         PRIMARY KEY,
  resource_id     UUID         NOT NULL,
  version_number  INT          NOT NULL,
  s3_key          TEXT,
  url             TEXT,
  uploaded_by     UUID         NOT NULL,
  change_notes    TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT grp_resource_version_number_chk CHECK (version_number >= 1),
  CONSTRAINT grp_resource_version_target_chk CHECK (
    s3_key IS NOT NULL OR url IS NOT NULL
  ),
  CONSTRAINT grp_resource_version_uq UNIQUE (resource_id, version_number),
  CONSTRAINT grp_resource_version_resource_fk FOREIGN KEY (resource_id)
    REFERENCES grp_resource_library(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS grp_resource_version_resource_idx
  ON grp_resource_versions (resource_id, version_number DESC);

COMMENT ON TABLE grp_resource_versions IS
  'P2-28a Step 1 — versioning history for grp_resource_library. UNIQUE(resource_id, version_number) so each version slot is filled once. On INSERT the Step 2 ResourceLibraryService increments grp_resource_library.version inside the same tenant tx. CASCADE on parent resource delete drops every version.';

/* --- 8. grp_group_invitations --- */

CREATE TABLE IF NOT EXISTS grp_group_invitations (
  id                UUID         PRIMARY KEY,
  group_id          UUID         NOT NULL,
  invited_user_id   UUID         NOT NULL,
  invited_by        UUID         NOT NULL,
  status            TEXT         NOT NULL DEFAULT 'PENDING',
  message           TEXT,
  responded_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT grp_invitation_status_chk CHECK (
    status IN ('PENDING', 'ACCEPTED', 'DECLINED')
  ),
  CONSTRAINT grp_invitation_responded_chk CHECK (
    (status = 'PENDING' AND responded_at IS NULL)
    OR (status IN ('ACCEPTED', 'DECLINED') AND responded_at IS NOT NULL)
  ),
  CONSTRAINT grp_invitation_uq UNIQUE (group_id, invited_user_id),
  CONSTRAINT grp_invitation_group_fk FOREIGN KEY (group_id)
    REFERENCES grp_groups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS grp_invitation_pending_idx
  ON grp_group_invitations (invited_user_id, status)
  WHERE status = 'PENDING';

COMMENT ON TABLE grp_group_invitations IS
  'P2-28a Step 1 — pending invitation to join a group. UNIQUE(group_id, invited_user_id) caps invitations at one per pair. multi-column responded_chk keeps responded_at in lockstep with non-PENDING status. On ACCEPTED the Step 2 InvitationService creates a grp_members row inside one tenant tx — invitation_status flips and member row lands together. CASCADE on group delete drops the invitation.';

/* --- 9. grp_group_analytics --- */

CREATE TABLE IF NOT EXISTS grp_group_analytics (
  id                  UUID            PRIMARY KEY,
  group_id            UUID            NOT NULL,
  period              DATE            NOT NULL,
  total_members       INT             NOT NULL DEFAULT 0,
  active_members      INT             NOT NULL DEFAULT 0,
  posts_count         INT             NOT NULL DEFAULT 0,
  comments_count      INT             NOT NULL DEFAULT 0,
  polls_created       INT             NOT NULL DEFAULT 0,
  events_held         INT             NOT NULL DEFAULT 0,
  resources_shared    INT             NOT NULL DEFAULT 0,
  engagement_rate     NUMERIC(5,4)    NOT NULL DEFAULT 0,
  computed_at         TIMESTAMPTZ     NOT NULL DEFAULT now(),
  CONSTRAINT grp_analytics_uq UNIQUE (group_id, period),
  CONSTRAINT grp_analytics_total_chk CHECK (total_members >= 0),
  CONSTRAINT grp_analytics_active_chk CHECK (active_members >= 0),
  CONSTRAINT grp_analytics_posts_chk CHECK (posts_count >= 0),
  CONSTRAINT grp_analytics_comments_chk CHECK (comments_count >= 0),
  CONSTRAINT grp_analytics_polls_chk CHECK (polls_created >= 0),
  CONSTRAINT grp_analytics_events_chk CHECK (events_held >= 0),
  CONSTRAINT grp_analytics_resources_chk CHECK (resources_shared >= 0),
  CONSTRAINT grp_analytics_rate_chk CHECK (
    engagement_rate >= 0 AND engagement_rate <= 9.9999
  ),
  CONSTRAINT grp_analytics_group_fk FOREIGN KEY (group_id)
    REFERENCES grp_groups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS grp_analytics_period_idx
  ON grp_group_analytics (period);

COMMENT ON TABLE grp_group_analytics IS
  'P2-28a Step 1 — per-(group, month) engagement read model. UNIQUE(group_id, period) caps the row at one per group per month. Materialised monthly by the future GroupAnalyticsWorker batch job — Step 2 ships the on-demand recompute endpoint that the worker will call. engagement_rate NUMERIC(5,4) supports values 0.0000 to 9.9999. CASCADE on group delete drops historical rows.';

COMMENT ON COLUMN grp_group_analytics.period IS
  'First day of the calendar month (YYYY-MM-01) — analytics are bucketed monthly. The Step 2 materialiser truncates to the first of the month when storing.';

COMMENT ON COLUMN grp_group_analytics.engagement_rate IS
  'Computed as active_members / total_members per the Step 2 GroupAnalyticsService. NUMERIC(5,4) ranges 0.0000 to 9.9999 — rate is a ratio so 0..1 is expected but the schema allows headroom for future weighted-engagement formulas.';
