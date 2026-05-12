/*
 * 158_alm_profiles_tags.sql — P2-22a Step 1.
 *
 * Alumni Module (M102). Phase 2 Cycle 22 — Wave D Module Completion.
 * Self-maintained alumni profiles (ADR-019) with opt-in directory plus
 * tag-based segmentation for campaign targeting.
 *
 *   alm_alumni_profiles    One row per alumni. Identity comes from
 *                          iam_person per ADR-055 — the same identity
 *                          the alumnus held as a student. Cross-schema
 *                          soft ref (no FK) to platform.iam_person per
 *                          ADR-001/020. UNIQUE(school_id, person_id)
 *                          so the same person cannot register twice at
 *                          the same school. RLS is enforced at the
 *                          service layer — alumni can only read or
 *                          update their own row, opt-in directory
 *                          listing filters on is_opted_in.
 *
 *   alm_alumni_tags        Tag-based segmentation rows for campaign
 *                          targeting. UNIQUE(alumni_id, tag). Tags
 *                          are free-text TEXT — common values:
 *                          STEM_MENTOR, DONOR, INTERNATIONAL,
 *                          BOARD_MEMBER, CAREER_SPEAKER. Admin can
 *                          create any tag, alumni can self-tag for
 *                          mentorship interests. GIN index supports
 *                          the segmentation query
 *                          (alm_campaign_recipients bulk-add by tag).
 *
 * FK summary (intra-tenant only, 0 cross-schema FK constraints):
 *   alm_alumni_tags.alumni_id   alm_alumni_profiles(id) ON DELETE CASCADE
 *
 * Splitter discipline — no semicolons inside string literals, default
 * expressions, COMMENT bodies, CHECK predicates, or block comments.
 * Idempotent — safe to re-run.
 */


CREATE TABLE IF NOT EXISTS alm_alumni_profiles (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  person_id                UUID NOT NULL,
  graduation_year          INT NOT NULL,
  degree_programme         TEXT,
  current_employer         TEXT,
  current_title            TEXT,
  linkedin_url             TEXT,
  contact_email            TEXT,
  contact_phone            TEXT,
  is_opted_in              BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT alm_alumni_profiles_uq UNIQUE (school_id, person_id),
  CONSTRAINT alm_alumni_profiles_year_chk CHECK (
    graduation_year BETWEEN 1900 AND 2100
  )
);

CREATE INDEX IF NOT EXISTS alm_alumni_profiles_year_idx
  ON alm_alumni_profiles (school_id, graduation_year);

CREATE INDEX IF NOT EXISTS alm_alumni_profiles_optin_idx
  ON alm_alumni_profiles (school_id, is_opted_in);

COMMENT ON TABLE alm_alumni_profiles IS
  'P2-22a — Self-maintained alumni profile per ADR-019. Identity links to platform.iam_person per ADR-055 (soft cross-schema ref, no DB FK per ADR-001/020). UNIQUE(school_id, person_id) caps registrations at one per school per identity. is_opted_in=false hides the row from the alumni directory but keeps it queryable by admin and visible to the owner. Service-layer RLS: alumni read or update only own row.';

COMMENT ON COLUMN alm_alumni_profiles.person_id IS
  'Soft FK to platform.iam_person per ADR-001/020. Identity continuity per ADR-055 — same person_id as when this alumnus was a student.';

COMMENT ON COLUMN alm_alumni_profiles.is_opted_in IS
  'Controls visibility in the alumni directory. The owner and admin always see the row regardless of this flag — only public directory listings respect it.';


CREATE TABLE IF NOT EXISTS alm_alumni_tags (
  id                       UUID PRIMARY KEY,
  alumni_id                UUID NOT NULL,
  tag                      TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT alm_alumni_tags_uq UNIQUE (alumni_id, tag),
  CONSTRAINT alm_alumni_tags_alumni_fk FOREIGN KEY (alumni_id)
    REFERENCES alm_alumni_profiles(id) ON DELETE CASCADE,
  CONSTRAINT alm_alumni_tags_tag_chk CHECK (length(trim(tag)) > 0)
);

CREATE INDEX IF NOT EXISTS alm_alumni_tags_tag_idx
  ON alm_alumni_tags USING GIN (to_tsvector('simple', tag));

CREATE INDEX IF NOT EXISTS alm_alumni_tags_alumni_idx
  ON alm_alumni_tags (alumni_id);

COMMENT ON TABLE alm_alumni_tags IS
  'P2-22a — Tag-based segmentation rows. UNIQUE(alumni_id, tag). Tags are free-text to let schools coin their own segmentation conventions (common values STEM_MENTOR, DONOR, INTERNATIONAL, BOARD_MEMBER, CAREER_SPEAKER). GIN index supports the segmentation query that resolves a tag to a list of alumni_ids for bulk campaign recipient add.';
