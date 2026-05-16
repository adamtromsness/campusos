/* 168_pfl_sections_reflections.sql
 * Phase 2 Cycle 27 — Portfolio Advanced. Step 1 of 3 schema steps
 * adding the 8 deferred ERD tables from Cycle 24 M26 Portfolio.
 *
 *   pfl_portfolio_sections     Student-driven organisation of portfolio
 *                              items into named sections (Academic
 *                              Work, Art Portfolio, etc.) with drag
 *                              reorder support. CASCADE on portfolio_id
 *                              since sections have no meaning without
 *                              their parent. UNIQUE(portfolio_id,
 *                              sort_order) keeps each section position
 *                              unique within a portfolio — the Step 5
 *                              service updates sort_order inside one
 *                              tenant tx with explicit reorder.
 *
 *   pfl_portfolio_items        Cycle 24 table — EXTENDED in this
 *                              migration with a nullable section_id FK
 *                              to pfl_portfolio_sections. ON DELETE
 *                              SET NULL so removing a section returns
 *                              its items to the unsectioned bucket
 *                              rather than deleting the items
 *                              themselves. Unsectioned items remain
 *                              valid first-class portfolio entries
 *                              per the plan and continue to render in
 *                              the unsectioned area of the organiser.
 *
 *   pfl_reflections            STUDENT-OWNED. UNIQUE(portfolio_item_id,
 *                              student_id) so a student writes at most
 *                              one reflection per item. The Step 5
 *                              ReflectionService enforces the student
 *                              owns the reflection — even teachers
 *                              cannot edit a student reflection. The
 *                              optional prompt column carries the
 *                              guided self-assessment prompt (What did
 *                              you learn, What would you do
 *                              differently) configured per-school via
 *                              the future platform_tenant_configs key
 *                              portfolio_reflection_prompts. CASCADE
 *                              on portfolio_item_id since a reflection
 *                              without its item is meaningless.
 *
 *   pfl_endorsements           Teacher / counsellor / mentor endorses
 *                              a portfolio with tagged skills and
 *                              comment. UNIQUE(portfolio_id,
 *                              endorsed_by) caps endorsements at one
 *                              per (portfolio, endorser) — re-endorsing
 *                              edits the existing row. 3-value
 *                              endorser_role CHECK TEACHER /
 *                              COUNSELLOR / MENTOR. skills TEXT[] non
 *                              empty per the cardinality CHECK — a
 *                              valueless endorsement is rejected.
 *                              endorsed_by SET NULL on hr_employees
 *                              delete so audit survives a teacher
 *                              leaving the school — matches the
 *                              Cycle 24 pfl_achievements.awarded_by
 *                              convention. is_visible_on_share is the
 *                              student-controlled toggle for whether
 *                              the endorsement renders on a shared
 *                              portfolio view (default true). Students
 *                              CANNOT endorse — enforced at the
 *                              Step 5 EndorsementService layer.
 *
 * 4 intra-tenant DB-enforced FKs in this migration (2 CASCADE on
 * children of pfl_portfolios + pfl_portfolio_items, 1 SET NULL on
 * endorsed_by, 1 SET NULL on pfl_portfolio_items.section_id). 0
 * cross-schema FKs — every other ref is soft per ADR-001/020.
 *
 * Splitter-safe — no semicolons inside string literals or block
 * comments. Idempotent — re-runs are a no-op, including the FK
 * backfill on the existing pfl_portfolio_items via the documented
 * DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT pattern (matches the
 * Cycle 9 BIP caseload_id precedent from Cycle 11 Step 3).
 */

/* ─── 1. Add section_id column to existing Cycle 24 table ─── */

ALTER TABLE pfl_portfolio_items
  ADD COLUMN IF NOT EXISTS section_id UUID;

/* ─── 2. pfl_portfolio_sections ─── */

CREATE TABLE IF NOT EXISTS pfl_portfolio_sections (
  id                   UUID         PRIMARY KEY,
  portfolio_id         UUID         NOT NULL,
  title                TEXT         NOT NULL,
  description          TEXT,
  sort_order           INT          NOT NULL,
  cover_image_s3_key   TEXT,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT pfl_section_portfolio_fk FOREIGN KEY (portfolio_id)
    REFERENCES pfl_portfolios(id) ON DELETE CASCADE,
  CONSTRAINT pfl_section_uq UNIQUE (portfolio_id, sort_order)
);

CREATE INDEX IF NOT EXISTS pfl_section_portfolio_idx
  ON pfl_portfolio_sections (portfolio_id, sort_order);

COMMENT ON TABLE pfl_portfolio_sections IS
  'Cycle 27 P2-27 Step 1 — student-driven portfolio sections with drag-reorder support. CASCADE on portfolio_id since sections are meaningless without their parent. UNIQUE(portfolio_id, sort_order) keeps positions unique within a portfolio. The Step 5 PortfolioSectionService updates sort_order inside one tenant tx with explicit reorder. Items assigned to sections via pfl_portfolio_items.section_id (nullable — unsectioned items remain valid).';

COMMENT ON COLUMN pfl_portfolio_sections.cover_image_s3_key IS
  'S3 key for an optional section cover image. Step 5 service issues a signed URL at read time. Null when no cover is uploaded.';

/* ─── 3. pfl_portfolio_items.section_id FK backfill ─── */
/* Splitter-safe DROP IF EXISTS + ADD pattern matching the Cycle 9 */
/* BIP caseload_id precedent from Cycle 11 Step 3. Idempotent.    */

ALTER TABLE pfl_portfolio_items
  DROP CONSTRAINT IF EXISTS pfl_item_section_fk;

ALTER TABLE pfl_portfolio_items
  ADD CONSTRAINT pfl_item_section_fk FOREIGN KEY (section_id)
    REFERENCES pfl_portfolio_sections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS pfl_item_section_idx
  ON pfl_portfolio_items (section_id)
  WHERE section_id IS NOT NULL;

COMMENT ON COLUMN pfl_portfolio_items.section_id IS
  'Cycle 27 P2-27 — nullable FK to pfl_portfolio_sections. ON DELETE SET NULL so removing a section returns items to the unsectioned bucket rather than deleting them. Unsectioned items continue to render in the unsectioned area of the Step 7 organiser.';

/* ─── 4. pfl_reflections ─── */

CREATE TABLE IF NOT EXISTS pfl_reflections (
  id                   UUID         PRIMARY KEY,
  portfolio_item_id    UUID         NOT NULL,
  student_id           UUID         NOT NULL,
  prompt               TEXT,
  reflection_text      TEXT         NOT NULL,
  written_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT pfl_reflection_item_fk FOREIGN KEY (portfolio_item_id)
    REFERENCES pfl_portfolio_items(id) ON DELETE CASCADE,
  CONSTRAINT pfl_reflection_uq UNIQUE (portfolio_item_id, student_id),
  CONSTRAINT pfl_reflection_text_chk CHECK (length(trim(reflection_text)) > 0)
);

CREATE INDEX IF NOT EXISTS pfl_reflection_student_idx
  ON pfl_reflections (student_id, written_at DESC);

COMMENT ON TABLE pfl_reflections IS
  'Cycle 27 P2-27 Step 1 — STUDENT-OWNED reflective writing tied to a portfolio item. UNIQUE(portfolio_item_id, student_id) so a student writes at most one reflection per item. The Step 5 ReflectionService enforces only the owning student can write or edit — even teachers cannot edit a student reflection. CASCADE on portfolio_item_id since a reflection is meaningless without its item.';

COMMENT ON COLUMN pfl_reflections.prompt IS
  'Optional guided self-assessment prompt (What did you learn, What would you do differently, How does this connect to your goals). Prompts are configurable per-school via the future platform_tenant_configs key portfolio_reflection_prompts.';

COMMENT ON COLUMN pfl_reflections.student_id IS
  'Tenant-local soft reference to sis_students(id) per ADR-001/020 — validated at the application layer. The owning student must match the actor for any write or edit.';

/* ─── 5. pfl_endorsements ─── */

CREATE TABLE IF NOT EXISTS pfl_endorsements (
  id                       UUID         PRIMARY KEY,
  portfolio_id             UUID         NOT NULL,
  endorsed_by              UUID,
  endorser_role            TEXT         NOT NULL,
  skills                   TEXT[]       NOT NULL,
  comment                  TEXT         NOT NULL,
  is_visible_on_share      BOOLEAN      NOT NULL DEFAULT true,
  endorsed_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT pfl_endorsement_portfolio_fk FOREIGN KEY (portfolio_id)
    REFERENCES pfl_portfolios(id) ON DELETE CASCADE,
  CONSTRAINT pfl_endorsement_by_fk FOREIGN KEY (endorsed_by)
    REFERENCES hr_employees(id) ON DELETE SET NULL,
  CONSTRAINT pfl_endorsement_uq UNIQUE (portfolio_id, endorsed_by),
  CONSTRAINT pfl_endorsement_role_chk CHECK (
    endorser_role IN ('TEACHER', 'COUNSELLOR', 'MENTOR')
  ),
  CONSTRAINT pfl_endorsement_skills_chk CHECK (
    cardinality(skills) > 0
  ),
  CONSTRAINT pfl_endorsement_comment_chk CHECK (
    length(trim(comment)) > 0
  )
);

CREATE INDEX IF NOT EXISTS pfl_endorsement_portfolio_idx
  ON pfl_endorsements (portfolio_id);

CREATE INDEX IF NOT EXISTS pfl_endorsement_by_idx
  ON pfl_endorsements (endorsed_by)
  WHERE endorsed_by IS NOT NULL;

COMMENT ON TABLE pfl_endorsements IS
  'Cycle 27 P2-27 Step 1 — teacher / counsellor / mentor endorses a portfolio with tagged skills and comment. UNIQUE(portfolio_id, endorsed_by) caps endorsements at one per (portfolio, endorser) so a teacher re-endorses by editing the existing row. SET NULL on endorsed_by so the endorsement survives a teacher leaving the school — matches Cycle 24 pfl_achievements.awarded_by audit convention. Students CANNOT endorse — enforced at the Step 5 EndorsementService layer via persona check.';

COMMENT ON COLUMN pfl_endorsements.skills IS
  'Non-empty TEXT array of tagged skills (Critical Thinking, Communication, Leadership, Perseverance, etc.) per the cardinality > 0 CHECK. Resume builder aggregates these via UNION across all endorsements for the student.';

COMMENT ON COLUMN pfl_endorsements.endorser_role IS
  '3-value CHECK TEACHER / COUNSELLOR / MENTOR. The role label is independent of the endorser hr_employees row — a counsellor who endorses as a TEACHER (e.g. teaching an elective) records the role under which they are endorsing.';

COMMENT ON COLUMN pfl_endorsements.is_visible_on_share IS
  'Student-controlled visibility toggle for shared portfolio view (default true). When false the endorsement is hidden from the public share-token view AND from teacher/parent visibility tiers but remains visible to the owning student. Step 5 service exposes PATCH /endorsements/:id/visibility for the student to toggle.';
