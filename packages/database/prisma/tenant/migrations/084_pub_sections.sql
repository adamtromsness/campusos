/* ============================================================
 * Cycle 25 — Step 2: Sections + Contributors + Comments (Tenant)
 * ============================================================
 *
 * Step 2 lands 3 logical base tables for the multi-section
 * authoring model:
 *
 *   - pub_sections: per-publication content blocks. 5-value
 *     section_type CHECK ARTICLE/ANNOUNCEMENT/PHOTO_GALLERY/
 *     CALENDAR/CUSTOM. owner_id is DB-enforced FK on hr_employees
 *     SET NULL — when the responsible employee leaves the school
 *     the section row survives with owner_id NULL. is_approved
 *     is the ADR-035 keystone: student-owned sections require an
 *     editor or admin to flip the flag before the parent
 *     publication can advance to APPROVED.
 *
 *   - pub_section_contributors: per-(section, contributor) row
 *     for contribution attribution beyond the section owner.
 *     UNIQUE(section, contributor). CASCADE on section delete.
 *     contributor_id is a soft FK to platform_users per
 *     ADR-001/020.
 *
 *   - pub_section_comments: threaded editorial review thread.
 *     parent_comment_id self-FK SET NULL so deleting a parent
 *     comment leaves replies orphaned but visible. is_resolved
 *     + resolved_by + resolved_at carry the resolution audit
 *     and CASCADE on section delete since the comment thread has
 *     no meaning without its section.
 *
 * 4 new intra-tenant DB-enforced FKs (3 CASCADE on section
 * children + parent_comment_id self-FK SET NULL) + 1 SET NULL
 * on hr_employees + 1 self-FK SET NULL on parent_comment_id +
 * 2 NO ACTION on resolved_by audit.
 *
 * Splitter-safe — no semicolons inside string literals or block
 * comments. Idempotent — re-runs are a no-op.
 * ============================================================ */

CREATE TABLE IF NOT EXISTS pub_sections (
  id              UUID PRIMARY KEY,
  publication_id  UUID NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT,
  section_type    TEXT NOT NULL DEFAULT 'ARTICLE',
  owner_id        UUID,
  sort_order      INT NOT NULL,
  is_approved     BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pub_section_type_chk CHECK (
    section_type IN ('ARTICLE', 'ANNOUNCEMENT', 'PHOTO_GALLERY', 'CALENDAR', 'CUSTOM')
  ),
  CONSTRAINT pub_section_sort_chk CHECK (sort_order >= 0),
  CONSTRAINT pub_section_publication_fk FOREIGN KEY (publication_id)
    REFERENCES pub_publications(id) ON DELETE CASCADE,
  CONSTRAINT pub_section_owner_fk FOREIGN KEY (owner_id)
    REFERENCES hr_employees(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS pub_section_publication_idx
  ON pub_sections (publication_id, sort_order);

CREATE INDEX IF NOT EXISTS pub_section_approval_idx
  ON pub_sections (publication_id, is_approved);

COMMENT ON TABLE pub_sections IS
  'Cycle 25 — content sections within a publication. CASCADE on parent publication. owner_id is DB-enforced FK on hr_employees with SET NULL so the section survives the responsible employee leaving the school. is_approved is the ADR-035 keystone — student-authored sections require editor or admin approval before the parent publication can advance to APPROVED.';

COMMENT ON COLUMN pub_sections.is_approved IS
  'ADR-035 approval gate. Defaults false. Editor or admin flips to true via the Step 6 SectionService.approve endpoint. Step 5 PublicationService.advance refuses APPROVED status when any section has is_approved=false.';

COMMENT ON COLUMN pub_sections.owner_id IS
  'DB-enforced FK on hr_employees(id) with ON DELETE SET NULL. The responsible employee for this section. When student-authored sections land via CONTRIBUTOR collaborators, owner_id may be NULL and the contribution is tracked via pub_section_contributors.';

CREATE TABLE IF NOT EXISTS pub_section_contributors (
  id                 UUID PRIMARY KEY,
  section_id         UUID NOT NULL,
  contributor_id     UUID NOT NULL,
  contribution_note  TEXT,
  contributed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pub_section_contrib_uq UNIQUE (section_id, contributor_id),
  CONSTRAINT pub_section_contrib_section_fk FOREIGN KEY (section_id)
    REFERENCES pub_sections(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS pub_section_contrib_contributor_idx
  ON pub_section_contributors (contributor_id);

COMMENT ON TABLE pub_section_contributors IS
  'Cycle 25 — per-(section, contributor) attribution rows for credit tracking beyond the section owner. CASCADE on section. UNIQUE(section, contributor). contributor_id is a soft FK to platform.platform_users per ADR-001/020.';

COMMENT ON COLUMN pub_section_contributors.contributor_id IS
  'Soft FK to platform.platform_users(id) per ADR-001/020. Validated at the application layer.';

CREATE TABLE IF NOT EXISTS pub_section_comments (
  id                  UUID PRIMARY KEY,
  section_id          UUID NOT NULL,
  author_id           UUID NOT NULL,
  body                TEXT NOT NULL,
  is_resolved         BOOLEAN NOT NULL DEFAULT false,
  resolved_by         UUID,
  resolved_at         TIMESTAMPTZ,
  parent_comment_id   UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pub_section_comment_resolved_chk CHECK (
    (is_resolved = false AND resolved_by IS NULL AND resolved_at IS NULL)
    OR (is_resolved = true AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  CONSTRAINT pub_section_comment_section_fk FOREIGN KEY (section_id)
    REFERENCES pub_sections(id) ON DELETE CASCADE,
  CONSTRAINT pub_section_comment_parent_fk FOREIGN KEY (parent_comment_id)
    REFERENCES pub_section_comments(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS pub_section_comment_section_idx
  ON pub_section_comments (section_id, is_resolved, created_at);

CREATE INDEX IF NOT EXISTS pub_section_comment_parent_idx
  ON pub_section_comments (parent_comment_id)
  WHERE parent_comment_id IS NOT NULL;

COMMENT ON TABLE pub_section_comments IS
  'Cycle 25 — threaded editorial review comments on a section. CASCADE on section delete since the thread has no meaning without its section. parent_comment_id self-FK SET NULL so deleting a parent comment leaves replies visible (un-threaded). multi-column resolved_chk keeps is_resolved + resolved_by + resolved_at in lockstep.';

COMMENT ON COLUMN pub_section_comments.author_id IS
  'Soft FK to platform.platform_users(id) per ADR-001/020. Validated at the application layer.';

COMMENT ON COLUMN pub_section_comments.resolved_by IS
  'Soft FK to platform.platform_users(id) per ADR-001/020. Set together with resolved_at via the multi-column resolved_chk lockstep.';
