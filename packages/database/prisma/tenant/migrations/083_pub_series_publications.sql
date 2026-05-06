/* ============================================================
 * Cycle 25 — Step 1: Series + Editions + Publications (Tenant)
 * ============================================================
 *
 * The M42 Publications module turns the school newsletter, the
 * principal bulletin, the student magazine, and the athletic
 * programme into structured, version-tracked, collaboratively-
 * authored platform objects with targeted distribution. Closes
 * Wave 5 (Academic Advanced).
 *
 * Step 1 lands 4 logical base tables:
 *
 *   - pub_series: the recurring brand container. UNIQUE(school,
 *     title) so a school carries one "Weekly Eagle" per name.
 *     6-value publication_type CHECK and 7-value frequency CHECK.
 *
 *   - pub_edition: numbered instances within a series. UNIQUE(
 *     series, edition_number) with auto-increment handled by the
 *     Step 5 EditionService. 5-value status CHECK (DRAFT,
 *     IN_REVIEW, APPROVED, PUBLISHED, ARCHIVED). soft
 *     approval_request_id ref to wsk_approval_requests per
 *     ADR-035 + Cycle 7 integration.
 *
 *   - pub_publications: a content document. May be standalone
 *     (series_id NULL) or belong to an edition. The multi-column
 *     edition_chk keystone enforces edition_id IS NULL OR
 *     series_id IS NOT NULL since an edition only exists inside
 *     a series. Same 5-value status CHECK and approval_request_id
 *     soft ref as pub_edition.
 *
 *   - pub_publication_collaborators: per-(publication, user)
 *     role assignment. UNIQUE(publication, user). 4-value role
 *     CHECK (EDITOR, CONTRIBUTOR, REVIEWER, VIEWER) covers the
 *     authoring matrix.
 *
 * 5 new intra-tenant DB-enforced FKs (3 CASCADE for parent-child
 * lifecycle: edition -> series, publication-collab -> publication,
 * + 2 NO ACTION for audit preservation: publication -> series,
 * publication -> edition). 0 cross-schema DB-enforced FKs — the
 * platform_users + hr_employees + wsk_approval_requests refs are
 * all soft per ADR-001/020.
 *
 * Splitter-safe — no semicolons inside string literals or block
 * comments. Idempotent — re-runs are a no-op.
 * ============================================================ */

CREATE TABLE IF NOT EXISTS pub_series (
  id                  UUID PRIMARY KEY,
  school_id           UUID NOT NULL,
  title               TEXT NOT NULL,
  description         TEXT,
  publication_type    TEXT NOT NULL,
  frequency           TEXT NOT NULL,
  series_logo_s3_key  TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pub_series_type_chk CHECK (
    publication_type IN ('NEWSLETTER', 'BULLETIN', 'ANNOUNCEMENT', 'MAGAZINE', 'PROGRAM', 'REPORT')
  ),
  CONSTRAINT pub_series_frequency_chk CHECK (
    frequency IN ('DAILY', 'WEEKLY', 'FORTNIGHTLY', 'MONTHLY', 'TERMLY', 'ANNUAL', 'IRREGULAR')
  ),
  CONSTRAINT pub_series_uq UNIQUE (school_id, title),
  CONSTRAINT pub_series_created_by_fk FOREIGN KEY (created_by)
    REFERENCES hr_employees(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS pub_series_school_idx
  ON pub_series (school_id, is_active);

COMMENT ON TABLE pub_series IS
  'Cycle 25 — recurring publication series (the brand). UNIQUE(school, title). publication_type 6-value CHECK NEWSLETTER/BULLETIN/ANNOUNCEMENT/MAGAZINE/PROGRAM/REPORT. frequency 7-value CHECK DAILY/WEEKLY/FORTNIGHTLY/MONTHLY/TERMLY/ANNUAL/IRREGULAR. created_by is DB-enforced FK on hr_employees with SET NULL so series survives the founding editor leaving the school.';

COMMENT ON COLUMN pub_series.created_by IS
  'DB-enforced FK to hr_employees(id) ON DELETE SET NULL so the series survives a founding editor leaving the school.';

CREATE TABLE IF NOT EXISTS pub_edition (
  id                     UUID PRIMARY KEY,
  series_id              UUID NOT NULL,
  edition_number         INT NOT NULL,
  edition_label          TEXT,
  theme                  TEXT,
  cover_image_s3_key     TEXT,
  editorial_note         TEXT,
  status                 TEXT NOT NULL DEFAULT 'DRAFT',
  scheduled_publish_at   TIMESTAMPTZ,
  published_at           TIMESTAMPTZ,
  editor_id              UUID,
  approval_request_id    UUID,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pub_edition_status_chk CHECK (
    status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'ARCHIVED')
  ),
  CONSTRAINT pub_edition_number_chk CHECK (edition_number > 0),
  CONSTRAINT pub_edition_uq UNIQUE (series_id, edition_number),
  CONSTRAINT pub_edition_series_fk FOREIGN KEY (series_id)
    REFERENCES pub_series(id) ON DELETE CASCADE,
  CONSTRAINT pub_edition_editor_fk FOREIGN KEY (editor_id)
    REFERENCES hr_employees(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS pub_edition_series_idx
  ON pub_edition (series_id, edition_number DESC);

CREATE INDEX IF NOT EXISTS pub_edition_status_idx
  ON pub_edition (series_id, status);

COMMENT ON TABLE pub_edition IS
  'Cycle 25 — numbered editions within a series. UNIQUE(series, edition_number) — auto-incremented per series by the Step 5 EditionService. 5-value status CHECK DRAFT/IN_REVIEW/APPROVED/PUBLISHED/ARCHIVED. CASCADE on parent series so deleting a series wipes its history. editor_id is DB-enforced FK on hr_employees with SET NULL.';

COMMENT ON COLUMN pub_edition.approval_request_id IS
  'Soft FK to wsk_approval_requests(id) per ADR-001/020 and ADR-035. Set by the Step 5 EditionService when the edition is submitted for approval. Resolution flips the edition status to APPROVED via the Cycle 7 approval engine consumer.';

CREATE TABLE IF NOT EXISTS pub_publications (
  id                     UUID PRIMARY KEY,
  school_id              UUID NOT NULL,
  title                  TEXT NOT NULL,
  publication_type       TEXT NOT NULL,
  series_id              UUID,
  edition_id             UUID,
  created_by             UUID,
  status                 TEXT NOT NULL DEFAULT 'DRAFT',
  scheduled_publish_at   TIMESTAMPTZ,
  published_at           TIMESTAMPTZ,
  approval_request_id    UUID,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pub_publication_type_chk CHECK (
    publication_type IN ('NEWSLETTER', 'BULLETIN', 'ANNOUNCEMENT', 'MAGAZINE', 'PROGRAM', 'REPORT')
  ),
  CONSTRAINT pub_publication_status_chk CHECK (
    status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'ARCHIVED')
  ),
  CONSTRAINT pub_publication_edition_chk CHECK (
    edition_id IS NULL OR series_id IS NOT NULL
  ),
  CONSTRAINT pub_publication_series_fk FOREIGN KEY (series_id)
    REFERENCES pub_series(id) ON DELETE NO ACTION,
  CONSTRAINT pub_publication_edition_fk FOREIGN KEY (edition_id)
    REFERENCES pub_edition(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS pub_publication_school_status_idx
  ON pub_publications (school_id, status, published_at DESC);

CREATE INDEX IF NOT EXISTS pub_publication_series_idx
  ON pub_publications (series_id)
  WHERE series_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS pub_publication_edition_idx
  ON pub_publications (edition_id)
  WHERE edition_id IS NOT NULL;

COMMENT ON TABLE pub_publications IS
  'Cycle 25 — content documents. Standalone when series_id IS NULL. multi-column pub_publication_edition_chk enforces edition_id IS NULL OR series_id IS NOT NULL since an edition only exists inside a series. NO ACTION on series + edition deletes preserves the publication audit trail. created_by is a soft FK to platform.platform_users per ADR-001/020.';

COMMENT ON COLUMN pub_publications.created_by IS
  'Soft FK to platform.platform_users(id) per ADR-001/020. Validated at the application layer.';

COMMENT ON COLUMN pub_publications.approval_request_id IS
  'Soft FK to wsk_approval_requests(id) per ADR-035. ADR-035 staff-authored publications publish directly. Student-authored sections require the Step 5 PublicationService.advance gate to verify all sections are approved before transitioning to APPROVED.';

CREATE TABLE IF NOT EXISTS pub_publication_collaborators (
  id              UUID PRIMARY KEY,
  publication_id  UUID NOT NULL,
  user_id         UUID NOT NULL,
  role            TEXT NOT NULL,
  invited_by      UUID,
  invited_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at     TIMESTAMPTZ,
  CONSTRAINT pub_collab_role_chk CHECK (
    role IN ('EDITOR', 'CONTRIBUTOR', 'REVIEWER', 'VIEWER')
  ),
  CONSTRAINT pub_collab_uq UNIQUE (publication_id, user_id),
  CONSTRAINT pub_collab_publication_fk FOREIGN KEY (publication_id)
    REFERENCES pub_publications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS pub_collab_user_idx
  ON pub_publication_collaborators (user_id);

COMMENT ON TABLE pub_publication_collaborators IS
  'Cycle 25 — per-(publication, user) role assignment. CASCADE on publication delete since the role has no meaning without the publication. UNIQUE(publication, user) so a user holds at most one role per publication. user_id is a soft FK to platform.platform_users per ADR-001/020.';

COMMENT ON COLUMN pub_publication_collaborators.user_id IS
  'Soft FK to platform.platform_users(id) per ADR-001/020. Validated at the application layer.';

COMMENT ON COLUMN pub_publication_collaborators.role IS
  '4-value CHECK EDITOR/CONTRIBUTOR/REVIEWER/VIEWER. EDITOR can publish + manage sections + invite. CONTRIBUTOR authors a section. REVIEWER comments + approves. VIEWER read-only collaborator.';
