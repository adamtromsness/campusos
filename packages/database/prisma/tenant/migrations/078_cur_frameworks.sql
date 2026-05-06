/* ============================================================
 * Cycle 23 — Step 1: Framework + Standards (Tenant)
 * ============================================================
 *
 * Tenant-side curriculum framework tables. Platform-seeded
 * frameworks (CCSS, NGSS) live in
 * platform.cur_standards_frameworks_platform +
 * platform.cur_standards_platform. Schools adopt platform
 * frameworks via cur_school_framework_adoptions and may also
 * create their own school-custom frameworks in
 * cur_standards_frameworks + cur_standards.
 *
 * The cur_unit_standards.standard_id column (Step 2) resolves
 * from EITHER platform OR tenant via app-layer dual resolution
 * per ADR-001/020 — the soft integrity pattern.
 *
 * 3 logical base tables:
 *
 *   - cur_school_framework_adoptions — links the school to a
 *     platform framework for an academic year. UNIQUE(school,
 *     platform_framework, academic_year). DB-enforced FK on
 *     academic_year_id (sis_academic_years). platform_framework_id
 *     is a soft FK to platform.cur_standards_frameworks_platform
 *     per ADR-001/020.
 *   - cur_standards_frameworks — school-created custom frameworks.
 *     UNIQUE(school, name, version). school_id NOT NULL — platform
 *     frameworks never live in this table.
 *   - cur_standards — school-created custom standards under a
 *     custom framework. UNIQUE(framework_id, code). framework_id
 *     FK CASCADE on parent cur_standards_frameworks.
 *
 * Splitter-safe — no semicolons inside string literals or block
 * comments. Idempotent — re-runs are a no-op.
 * ============================================================ */

CREATE TABLE IF NOT EXISTS cur_school_framework_adoptions (
  id                     UUID PRIMARY KEY,
  school_id              UUID NOT NULL,
  platform_framework_id  UUID NOT NULL,
  academic_year_id       UUID NOT NULL,
  adopted_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  adopted_by             UUID NOT NULL,
  notes                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cur_adoption_uq UNIQUE (school_id, platform_framework_id, academic_year_id),
  CONSTRAINT cur_adoption_year_fk FOREIGN KEY (academic_year_id)
    REFERENCES sis_academic_years(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS cur_adoption_school_year_idx
  ON cur_school_framework_adoptions (school_id, academic_year_id);

COMMENT ON TABLE cur_school_framework_adoptions IS
  'Cycle 23 — links a school to a platform-seeded framework (CCSS, NGSS) for an academic year. UNIQUE(school, platform_framework, year). platform_framework_id is a soft FK to platform.cur_standards_frameworks_platform per ADR-001/020. academic_year_id is DB-enforced FK on sis_academic_years.';

COMMENT ON COLUMN cur_school_framework_adoptions.platform_framework_id IS
  'Soft FK to platform.cur_standards_frameworks_platform.id per ADR-001/020. Validated at the application layer.';

CREATE TABLE IF NOT EXISTS cur_standards_frameworks (
  id           UUID PRIMARY KEY,
  school_id    UUID NOT NULL,
  name         TEXT NOT NULL,
  version      TEXT,
  description  TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_by   UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cur_framework_uq UNIQUE (school_id, name, version)
);

CREATE INDEX IF NOT EXISTS cur_framework_school_idx
  ON cur_standards_frameworks (school_id, is_active);

COMMENT ON TABLE cur_standards_frameworks IS
  'Cycle 23 — school-created custom frameworks. school_id NOT NULL — platform frameworks live in platform.cur_standards_frameworks_platform and never appear here. UNIQUE(school, name, version) so a school can carry multiple versions of the same custom framework.';

CREATE TABLE IF NOT EXISTS cur_standards (
  id            UUID PRIMARY KEY,
  framework_id  UUID NOT NULL,
  code          TEXT NOT NULL,
  description   TEXT NOT NULL,
  grade_band    TEXT,
  domain        TEXT,
  cluster       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cur_standard_uq UNIQUE (framework_id, code),
  CONSTRAINT cur_standard_framework_fk FOREIGN KEY (framework_id)
    REFERENCES cur_standards_frameworks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cur_standard_framework_idx
  ON cur_standards (framework_id, grade_band);

COMMENT ON TABLE cur_standards IS
  'Cycle 23 — school-created custom standards under a custom framework. UNIQUE(framework_id, code). CASCADE on parent framework — standards have no meaning without their framework. The Step 4 StandardService combines this catalogue with platform.cur_standards_platform for unified search.';
