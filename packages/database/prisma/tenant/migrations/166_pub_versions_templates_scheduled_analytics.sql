/* 166_pub_versions_templates_scheduled_analytics.sql
 * Phase 2 Cycle 26 — M25 Publications Advanced. 4 new tenant base
 * tables completing the deferred portion of the M25 Publications
 * module from Cycle 25.
 *
 *   pub_publication_versions   IMMUTABLE per ADR-010. No UPDATE, no
 *                              DELETE at the service layer. Each row
 *                              is a complete JSONB snapshot of the
 *                              publications content at a point in
 *                              time. Versions are created
 *                              automatically on every status
 *                              transition DRAFT to IN_REVIEW to
 *                              APPROVED to PUBLISHED, plus on
 *                              explicit Save Checkpoint by the
 *                              editor, plus on Revert which creates
 *                              a NEW version derived from an earlier
 *                              snapshot (never modifies an existing
 *                              row). The version trail is the
 *                              publications complete audit history.
 *
 *                              CASCADE on publication_id since
 *                              versions are meaningless without
 *                              their parent publication. UNIQUE on
 *                              publication_id, version_number is the
 *                              monotonic version counter the Step 3
 *                              VersionService increments inside one
 *                              tenant tx. 3-value trigger CHECK
 *                              records STATUS_CHANGE for automatic
 *                              transitions, MANUAL_CHECKPOINT for
 *                              editor-initiated saves, and REVERT
 *                              for the append-only revert path.
 *
 *   pub_templates              Reusable publication structure
 *                              templates. school_id NULL means
 *                              platform-seeded with is_system=true
 *                              so every school sees the catalogue —
 *                              schools can also author custom
 *                              templates with school_id populated.
 *                              The COALESCE-sentinel UNIQUE INDEX on
 *                              COALESCE(school_id, sentinel-uuid),
 *                              name lets a NULL school_id row
 *                              coexist with same-name custom rows
 *                              from different schools — matching the
 *                              Cycle 5 sch_periods and Cycle 12
 *                              lib_reading_lists pattern. The Step 3
 *                              TemplateService refuses any UPDATE or
 *                              DELETE on is_system=true rows.
 *
 *   pub_scheduled_publications One-to-one with the parent
 *                              publication via UNIQUE publication_id
 *                              so a publication carries at most one
 *                              active schedule. scheduled_at is the
 *                              instant the worker fires. timezone is
 *                              the schools display zone for editor
 *                              UI rendering only — the DB stores
 *                              every timestamp in UTC per ADR
 *                              convention. 3-value status CHECK
 *                              walks SCHEDULED to PUBLISHED on
 *                              worker success, or to CANCELLED if
 *                              the editor cancels the schedule
 *                              before fire time. The Step 4
 *                              ScheduledPublishWorker polls every
 *                              minute and processes rows where
 *                              status=SCHEDULED AND scheduled_at <=
 *                              now() — the partial INDEX hot path.
 *
 *   pub_publication_analytics  Per-publication engagement counters
 *                              maintained by the Step 4
 *                              PublicationAnalyticsService. One-to
 *                              -one with the publication via UNIQUE
 *                              publication_id. Counters are
 *                              incremented atomically through SQL
 *                              level statements like
 *                              SET total_views = total_views + 1
 *                              so concurrent events from the Cycle
 *                              14 fan-out pipeline cannot lose
 *                              counts. The Step 6 vertical-slice
 *                              test exercises the atomic-increment
 *                              path under 5 parallel POSTs.
 *
 * 4 new intra-tenant DB-enforced FKs (CASCADE × 3 on parent
 * publication for versions + scheduled + analytics, NO ACTION × 1
 * on pub_templates.parent_template_id — historical reference for
 * the from-template path). 0 cross-schema DB-enforced FKs — the
 * platform_users + hr_employees refs are all soft per ADR-001/020.
 *
 * Splitter-safe — no semicolons inside string literals or block
 * comments. Idempotent — re-runs are a no-op.
 */

CREATE TABLE IF NOT EXISTS pub_publication_versions (
  id                  UUID         PRIMARY KEY,
  publication_id      UUID         NOT NULL REFERENCES pub_publications(id) ON DELETE CASCADE,
  version_number      INT          NOT NULL,
  snapshot_content    JSONB        NOT NULL,
  trigger             TEXT         NOT NULL,
  reverted_from_version INT,
  version_note        TEXT,
  created_by          UUID         NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT pub_versions_number_chk
    CHECK (version_number > 0),
  CONSTRAINT pub_versions_trigger_chk
    CHECK (trigger IN ('STATUS_CHANGE', 'MANUAL_CHECKPOINT', 'REVERT')),
  CONSTRAINT pub_versions_revert_chk
    CHECK (
      (trigger = 'REVERT' AND reverted_from_version IS NOT NULL)
      OR (trigger <> 'REVERT' AND reverted_from_version IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS pub_versions_publication_number_uq
  ON pub_publication_versions (publication_id, version_number);

CREATE INDEX IF NOT EXISTS pub_versions_publication_desc_idx
  ON pub_publication_versions (publication_id, version_number DESC);

CREATE INDEX IF NOT EXISTS pub_versions_created_at_idx
  ON pub_publication_versions (created_at DESC);

COMMENT ON TABLE pub_publication_versions IS
  'Phase 2 Cycle 26 — IMMUTABLE per ADR-010. The Step 3 VersionService is the sole writer and exposes only list + getById + checkpoint + revert. No UPDATE method, no DELETE method. Versions are created automatically on every status transition by PublicationService.patchStatus, on every explicit checkpoint by the editor, and on revert (which creates a NEW row from an earlier snapshot — never modifies an existing row). CASCADE on publication_id since versions are meaningless without their parent.';

COMMENT ON COLUMN pub_publication_versions.snapshot_content IS
  'JSONB snapshot of the publications content at this point in time. Schema is {title, status, publicationType, sections: [{id, title, body, sortOrder, isApproved}], publishedAt}. The Step 3 VersionService.captureSnapshot helper composes this from pub_publications + pub_sections inside the same tenant tx as the version INSERT.';

COMMENT ON COLUMN pub_publication_versions.trigger IS
  'STATUS_CHANGE — auto-created by PublicationService.patchStatus on every DRAFT to IN_REVIEW to APPROVED to PUBLISHED transition. MANUAL_CHECKPOINT — editor explicitly saved via POST /publications/:id/checkpoint. REVERT — created by POST /publications/:id/revert and reverted_from_version is populated.';

COMMENT ON COLUMN pub_publication_versions.reverted_from_version IS
  'NULL for STATUS_CHANGE and MANUAL_CHECKPOINT rows. Populated with the version_number that was reverted to. The new row is appended at the next version_number — the previous versions remain unchanged. Append-only revert per the cycle plan.';

CREATE TABLE IF NOT EXISTS pub_templates (
  id                  UUID         PRIMARY KEY,
  school_id           UUID,
  name                TEXT         NOT NULL,
  description         TEXT,
  publication_type    TEXT         NOT NULL,
  template_content    JSONB        NOT NULL,
  is_system           BOOLEAN      NOT NULL DEFAULT false,
  is_active           BOOLEAN      NOT NULL DEFAULT true,
  parent_template_id  UUID         REFERENCES pub_templates(id) ON DELETE SET NULL,
  created_by          UUID,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT pub_templates_type_chk
    CHECK (publication_type IN ('NEWSLETTER', 'BULLETIN', 'ANNOUNCEMENT', 'MAGAZINE', 'PROGRAM', 'REPORT')),
  CONSTRAINT pub_templates_system_chk
    CHECK ((is_system = true AND school_id IS NULL) OR (is_system = false))
);

CREATE UNIQUE INDEX IF NOT EXISTS pub_templates_school_name_uq
  ON pub_templates (
    COALESCE(school_id, '00000000-0000-0000-0000-000000000000'::uuid),
    name
  );

CREATE INDEX IF NOT EXISTS pub_templates_school_active_idx
  ON pub_templates (school_id, is_active);

CREATE INDEX IF NOT EXISTS pub_templates_type_idx
  ON pub_templates (publication_type, is_active);

COMMENT ON TABLE pub_templates IS
  'Phase 2 Cycle 26 — Reusable publication structure. The Step 7 platform seeder inserts is_system=true rows with school_id=NULL covering Monthly Newsletter, Weekly Bulletin, and Annual Report. Schools may also author custom templates with school_id populated — the COALESCE-sentinel UNIQUE INDEX lets a platform-seeded Monthly Newsletter coexist with a same-name custom row in each tenant. The Step 3 TemplateService refuses any UPDATE or DELETE against is_system=true rows.';

COMMENT ON COLUMN pub_templates.template_content IS
  'JSONB schema {sections: [{title, sortOrder, ownerHint}], suggestedFrequency, defaultDistributionLists}. The Step 3 from-template path reads this to materialise pub_sections rows on the new publication.';

COMMENT ON COLUMN pub_templates.is_system IS
  'TRUE for platform-seeded templates that every school sees. The system_chk multi-column constraint requires school_id IS NULL when is_system=true so the Step 7 seeder cannot accidentally bind a system template to one tenant. The Step 3 TemplateService refuses UPDATE and DELETE on is_system=true rows with a 403.';

CREATE TABLE IF NOT EXISTS pub_scheduled_publications (
  id                  UUID         PRIMARY KEY,
  publication_id      UUID         NOT NULL UNIQUE REFERENCES pub_publications(id) ON DELETE CASCADE,
  scheduled_at        TIMESTAMPTZ  NOT NULL,
  timezone            TEXT         NOT NULL DEFAULT 'America/Chicago',
  status              TEXT         NOT NULL DEFAULT 'SCHEDULED',
  scheduled_by        UUID         NOT NULL,
  cancelled_at        TIMESTAMPTZ,
  cancelled_by        UUID,
  cancellation_reason TEXT,
  published_at        TIMESTAMPTZ,
  worker_attempts     INT          NOT NULL DEFAULT 0,
  last_error          TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT pub_sched_status_chk
    CHECK (status IN ('SCHEDULED', 'PUBLISHED', 'CANCELLED')),
  CONSTRAINT pub_sched_published_chk
    CHECK (
      (status = 'PUBLISHED' AND published_at IS NOT NULL)
      OR (status <> 'PUBLISHED' AND published_at IS NULL)
    ),
  CONSTRAINT pub_sched_cancelled_chk
    CHECK (
      (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
      OR (status <> 'CANCELLED' AND cancelled_at IS NULL AND cancelled_by IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS pub_sched_status_at_idx
  ON pub_scheduled_publications (status, scheduled_at)
  WHERE status = 'SCHEDULED';

CREATE INDEX IF NOT EXISTS pub_sched_scheduled_by_idx
  ON pub_scheduled_publications (scheduled_by);

COMMENT ON TABLE pub_scheduled_publications IS
  'Phase 2 Cycle 26 — Editor-scheduled publish queue. UNIQUE on publication_id so a publication carries at most one active schedule. The Step 4 ScheduledPublishWorker polls every minute and processes rows where status=SCHEDULED AND scheduled_at <= now() via the partial INDEX hot path. On worker success the row is flipped to PUBLISHED with published_at stamped + DistributionService.distribute is called inside the same tx + the Step 3 VersionService records a final STATUS_CHANGE version. On worker failure (transient broker outage, etc) worker_attempts is bumped and last_error is recorded — the row stays SCHEDULED so the next poll retries.';

COMMENT ON COLUMN pub_scheduled_publications.timezone IS
  'Display zone for the editor UI countdown. The DB stores every TIMESTAMPTZ in UTC per ADR convention — timezone is metadata only and not used by the worker for fire-time comparisons.';

COMMENT ON COLUMN pub_scheduled_publications.worker_attempts IS
  'Bumped by the Step 4 worker on every failed fire. The worker logs last_error to help operators triage a stuck row. The Step 6 vertical-slice test exercises the retry path.';

CREATE TABLE IF NOT EXISTS pub_publication_analytics (
  publication_id        UUID         PRIMARY KEY REFERENCES pub_publications(id) ON DELETE CASCADE,
  total_recipients      INT          NOT NULL DEFAULT 0,
  total_views           INT          NOT NULL DEFAULT 0,
  unique_views          INT          NOT NULL DEFAULT 0,
  total_opens           INT          NOT NULL DEFAULT 0,
  total_link_clicks     INT          NOT NULL DEFAULT 0,
  total_bounces         INT          NOT NULL DEFAULT 0,
  avg_read_time_seconds INT,
  last_event_at         TIMESTAMPTZ,
  last_updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT pub_analytics_counters_chk
    CHECK (
      total_recipients >= 0
      AND total_views >= 0
      AND unique_views >= 0
      AND total_opens >= 0
      AND total_link_clicks >= 0
      AND total_bounces >= 0
      AND (avg_read_time_seconds IS NULL OR avg_read_time_seconds >= 0)
    )
);

CREATE INDEX IF NOT EXISTS pub_analytics_last_event_idx
  ON pub_publication_analytics (last_event_at DESC);

COMMENT ON TABLE pub_publication_analytics IS
  'Phase 2 Cycle 26 — Per-publication engagement counters. One-to-one with pub_publications via the PK = FK pattern. Counters are incremented atomically via SQL-level UPDATE ... SET counter = counter + 1 so concurrent events from the Cycle 14 fan-out pipeline cannot lose counts. The Step 4 PublicationAnalyticsService is the canonical writer through ingestEvent. The Step 6 vertical-slice test exercises the atomic-increment path under 5 parallel POSTs to confirm no counter drops.';

COMMENT ON COLUMN pub_publication_analytics.unique_views IS
  'Distinct viewer count tracked via Redis SET notif:pub-views:{publicationId} with TTL=24h. The PublicationAnalyticsService.ingestEvent increments unique_views only when SADD returns 1 — the SET membership keystone.';

COMMENT ON COLUMN pub_publication_analytics.avg_read_time_seconds IS
  'Rolling average of read_time_seconds from view events. The Step 4 ingestEvent uses the standard running-average formula: avg_new = avg_old + ((value - avg_old) / count).';
