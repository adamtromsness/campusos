/*
 * 160_alm_news_reunions_events.sql — P2-22a Step 3.
 *
 * Alumni Module (M102) continued. Final 3 of the 8 tables — alumni
 * news feed, reunion group planning with RSVP coordination, alumni
 * events with optional P2-12 Events linkage.
 *
 *   alm_alumni_news       Alumni newsletter article. 4 value
 *                         category CHECK ACHIEVEMENT / EVENT /
 *                         OPPORTUNITY / GENERAL. published_at is
 *                         NULL for drafts, NOT NULL once published —
 *                         the Step 6 service stamps it on publish.
 *                         author_id is a soft ref to platform.iam_person
 *                         per ADR-001/020. INDEX(school_id,
 *                         published_at DESC) sorts the feed.
 *
 *   alm_reunion_groups    Class-year reunion organising row. 4 value
 *                         status CHECK PLANNING / CONFIRMED /
 *                         COMPLETED / CANCELLED. organiser_id is an
 *                         alm_alumni_profiles FK so a deleted alumnus
 *                         leaves the reunion record dangling — the
 *                         service refuses to delete an alumnus with
 *                         organised reunions. INDEX(school_id,
 *                         graduation_year) drives the per-year list.
 *
 *   alm_events            Alumni event header. evt_event_id is a
 *                         DISPLAY-ONLY soft reference to the future
 *                         P2-12 evt_events row. NO FK constraint —
 *                         the Alumni module compiles and runs whether
 *                         or not the Events module is enabled for
 *                         this tenant. When evt_event_id IS NOT NULL,
 *                         the Step 6 AlumniEventService enriches the
 *                         response via the Events API with graceful
 *                         fallback to rsvp_url when the call fails
 *                         or the row is missing.
 *
 * FK summary (intra-tenant only, 0 cross-schema FK constraints):
 *   alm_reunion_groups.organiser_id   alm_alumni_profiles(id) NO ACTION
 *
 * Splitter discipline — no semicolons inside string literals, default
 * expressions, COMMENT bodies, CHECK predicates, or block comments.
 * Idempotent — safe to re-run.
 */


CREATE TABLE IF NOT EXISTS alm_alumni_news (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  author_id                UUID NOT NULL,
  title                    TEXT NOT NULL,
  body                     TEXT NOT NULL,
  category                 TEXT NOT NULL,
  published_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT alm_alumni_news_category_chk CHECK (
    category IN ('ACHIEVEMENT', 'EVENT', 'OPPORTUNITY', 'GENERAL')
  ),
  CONSTRAINT alm_alumni_news_title_chk CHECK (length(trim(title)) > 0),
  CONSTRAINT alm_alumni_news_body_chk CHECK (length(trim(body)) > 0)
);

CREATE INDEX IF NOT EXISTS alm_alumni_news_published_idx
  ON alm_alumni_news (school_id, published_at DESC)
  WHERE published_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS alm_alumni_news_category_idx
  ON alm_alumni_news (school_id, category, published_at DESC);

COMMENT ON TABLE alm_alumni_news IS
  'P2-22a — Alumni newsletter article. published_at NULL means draft (admin-only visibility), populated means published (alumni feed). The Step 6 AlumniNewsService stamps published_at on publish. author_id is a soft ref to platform.iam_person per ADR-001/020.';


CREATE TABLE IF NOT EXISTS alm_reunion_groups (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  graduation_year          INT NOT NULL,
  name                     TEXT NOT NULL,
  organiser_id             UUID NOT NULL,
  event_date               DATE,
  rsvp_deadline            DATE,
  status                   TEXT NOT NULL DEFAULT 'PLANNING',
  description              TEXT,
  venue                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT alm_reunion_groups_status_chk CHECK (
    status IN ('PLANNING', 'CONFIRMED', 'COMPLETED', 'CANCELLED')
  ),
  CONSTRAINT alm_reunion_groups_year_chk CHECK (
    graduation_year BETWEEN 1900 AND 2100
  ),
  CONSTRAINT alm_reunion_groups_dates_chk CHECK (
    rsvp_deadline IS NULL OR event_date IS NULL OR rsvp_deadline <= event_date
  ),
  CONSTRAINT alm_reunion_groups_organiser_fk FOREIGN KEY (organiser_id)
    REFERENCES alm_alumni_profiles(id)
);

CREATE INDEX IF NOT EXISTS alm_reunion_groups_year_idx
  ON alm_reunion_groups (school_id, graduation_year);

CREATE INDEX IF NOT EXISTS alm_reunion_groups_status_idx
  ON alm_reunion_groups (school_id, status);

COMMENT ON TABLE alm_reunion_groups IS
  'P2-22a — Per-graduation-year reunion organising row. 4 value status CHECK PLANNING / CONFIRMED / COMPLETED / CANCELLED. The Step 6 service refuses to advance to CONFIRMED without event_date populated. organiser_id is a real FK (NO ACTION) to alm_alumni_profiles — deletion is refused while a reunion is organised.';


CREATE TABLE IF NOT EXISTS alm_events (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  title                    TEXT NOT NULL,
  description              TEXT,
  event_date               DATE NOT NULL,
  venue                    TEXT,
  rsvp_url                 TEXT,
  evt_event_id             UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT alm_events_title_chk CHECK (length(trim(title)) > 0)
);

CREATE INDEX IF NOT EXISTS alm_events_date_idx
  ON alm_events (school_id, event_date);

CREATE INDEX IF NOT EXISTS alm_events_evt_link_idx
  ON alm_events (evt_event_id)
  WHERE evt_event_id IS NOT NULL;

COMMENT ON TABLE alm_events IS
  'P2-22a — Alumni event header. evt_event_id is a DISPLAY-ONLY soft reference to the future P2-12 evt_events row. NO DB FK constraint by design — the Alumni module must compile and run regardless of whether the Events module is enabled in this tenant. The Step 6 AlumniEventService resolves evt_event_id at read time and falls back to rsvp_url when the Events API call fails or the row is missing.';

COMMENT ON COLUMN alm_events.evt_event_id IS
  'DISPLAY-ONLY soft ref to evt_events(id). No FK constraint per the P2-22 plan — the Alumni module is independent of the Events module. Service layer enriches the response with ticket data when the Events API responds, and falls back to rsvp_url otherwise.';
