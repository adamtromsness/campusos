/* ============================================================
 * Cycle 23 — Step 2: Curriculum Maps + Units + Alignment
 * ============================================================
 *
 * 6 logical base tables:
 *
 *   - cur_curriculum_maps — per-(school, year, subject, grade)
 *     scope-and-sequence container. 3-value status CHECK
 *     (DRAFT / PUBLISHED / ARCHIVED). framework_id is a soft FK
 *     resolved by the application from EITHER tenant
 *     cur_standards_frameworks OR platform
 *     cur_standards_frameworks_platform via
 *     cur_school_framework_adoptions per ADR-001/020.
 *     academic_year_id DB-enforced FK to sis_academic_years.
 *   - cur_units — ordered units per map. CASCADE on parent map.
 *     UNIQUE(curriculum_map_id, sequence_order). essential_questions
 *     TEXT[] for inquiry-based design. dates are inclusive.
 *   - cur_unit_standards — alignment of units to standards.
 *     UNIQUE(unit_id, standard_id). standard_id is the
 *     dual-resolution KEYSTONE — resolves from EITHER tenant
 *     cur_standards.id OR platform cur_standards_platform.id.
 *     Application-layer enforcement — no DB FK on standard_id.
 *   - cur_unit_lessons — links units to Cycle 2 cls_lessons.
 *     UNIQUE(unit_id, cls_lesson_id). cls_lesson_id is a soft FK
 *     to cls_lessons(id) per ADR-001/020 — the cross-cycle
 *     read-back keystone. Validated by the Step 5 service before
 *     INSERT via existence check against cls_lessons.
 *   - cur_delivery_gaps — MATERIALISED NIGHTLY (ADR-018). Never
 *     computed on demand. The Step 6 worker walks each PUBLISHED
 *     map's units, counts planned lessons (cur_unit_lessons) and
 *     delivered lessons (cls_lessons WHERE status='COMPLETED'),
 *     UPSERTs the gap row. UNIQUE(unit_id, standard_id). 3-value
 *     gap_type CHECK (NOT_STARTED / PARTIAL / COMPLETE).
 *   - cur_resource_links — teaching resources per unit.
 *     4-value resource_type CHECK (FILE / URL / VIDEO / TEXTBOOK).
 *     is_teacher_only filters resources from non-staff readers
 *     at the Step 6 ResourceLinkService boundary.
 *
 * Splitter-safe — no semicolons inside string literals or block
 * comments. Idempotent — re-runs are a no-op.
 * ============================================================ */

CREATE TABLE IF NOT EXISTS cur_curriculum_maps (
  id                UUID PRIMARY KEY,
  school_id         UUID NOT NULL,
  framework_id      UUID,
  academic_year_id  UUID NOT NULL,
  subject           TEXT NOT NULL,
  grade_level       TEXT NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'DRAFT',
  created_by        UUID NOT NULL,
  published_at      TIMESTAMPTZ,
  archived_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cur_map_status_chk CHECK (
    status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')
  ),
  CONSTRAINT cur_map_status_lockstep_chk CHECK (
    (status = 'DRAFT' AND published_at IS NULL AND archived_at IS NULL)
    OR (status = 'PUBLISHED' AND published_at IS NOT NULL AND archived_at IS NULL)
    OR (status = 'ARCHIVED' AND archived_at IS NOT NULL)
  ),
  CONSTRAINT cur_map_year_fk FOREIGN KEY (academic_year_id)
    REFERENCES sis_academic_years(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS cur_map_school_year_idx
  ON cur_curriculum_maps (school_id, academic_year_id, subject);

CREATE INDEX IF NOT EXISTS cur_map_status_idx
  ON cur_curriculum_maps (school_id, status);

COMMENT ON TABLE cur_curriculum_maps IS
  'Cycle 23 — per-(school, year, subject, grade) scope-and-sequence container. 3-value status CHECK with multi-column status_lockstep_chk pinning published_at and archived_at to status. framework_id is a soft FK resolved from EITHER tenant cur_standards_frameworks OR platform cur_standards_frameworks_platform per ADR-001/020.';

CREATE TABLE IF NOT EXISTS cur_units (
  id                   UUID PRIMARY KEY,
  curriculum_map_id    UUID NOT NULL,
  title                TEXT NOT NULL,
  description          TEXT,
  sequence_order       INT NOT NULL,
  estimated_weeks      INT,
  start_date           DATE,
  end_date             DATE,
  essential_questions  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cur_unit_seq_uq UNIQUE (curriculum_map_id, sequence_order),
  CONSTRAINT cur_unit_seq_positive_chk CHECK (sequence_order > 0),
  CONSTRAINT cur_unit_weeks_chk CHECK (estimated_weeks IS NULL OR estimated_weeks > 0),
  CONSTRAINT cur_unit_dates_chk CHECK (
    start_date IS NULL OR end_date IS NULL OR end_date >= start_date
  ),
  CONSTRAINT cur_unit_map_fk FOREIGN KEY (curriculum_map_id)
    REFERENCES cur_curriculum_maps(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cur_unit_map_idx
  ON cur_units (curriculum_map_id, sequence_order);

COMMENT ON TABLE cur_units IS
  'Cycle 23 — ordered units per curriculum map. CASCADE on parent map. UNIQUE(map, sequence_order) so re-orders must be batch-applied. essential_questions TEXT[] supports inquiry-based design.';

CREATE TABLE IF NOT EXISTS cur_unit_standards (
  id           UUID PRIMARY KEY,
  unit_id      UUID NOT NULL,
  standard_id  UUID NOT NULL,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cur_unit_std_uq UNIQUE (unit_id, standard_id),
  CONSTRAINT cur_unit_std_unit_fk FOREIGN KEY (unit_id)
    REFERENCES cur_units(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cur_unit_std_standard_idx
  ON cur_unit_standards (standard_id);

COMMENT ON TABLE cur_unit_standards IS
  'Cycle 23 — DUAL-RESOLUTION KEYSTONE. Aligns units to standards. UNIQUE(unit, standard). standard_id is a soft FK that resolves from EITHER tenant cur_standards.id OR platform.cur_standards_platform.id via app-layer lookup per ADR-001/020. The Step 5 UnitService.alignStandard validates the supplied standard_id resolves in one of the two catalogues before INSERT.';

CREATE TABLE IF NOT EXISTS cur_unit_lessons (
  id              UUID PRIMARY KEY,
  unit_id         UUID NOT NULL,
  cls_lesson_id   UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cur_unit_lesson_uq UNIQUE (unit_id, cls_lesson_id),
  CONSTRAINT cur_unit_lesson_unit_fk FOREIGN KEY (unit_id)
    REFERENCES cur_units(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cur_unit_lesson_lesson_idx
  ON cur_unit_lessons (cls_lesson_id);

COMMENT ON TABLE cur_unit_lessons IS
  'Cycle 23 — CROSS-CYCLE READ-BACK KEYSTONE. Links curriculum units to Cycle 2 cls_lessons. UNIQUE(unit, lesson). cls_lesson_id is a soft FK to cls_lessons(id) per ADR-001/020 — the Step 5 UnitService.linkLesson validates the lesson exists in the calling tenant before INSERT. The Step 6 DeliveryGapService nightly worker reads through this link to count planned vs delivered lessons.';

CREATE TABLE IF NOT EXISTS cur_delivery_gaps (
  id                  UUID PRIMARY KEY,
  unit_id             UUID NOT NULL,
  standard_id         UUID NOT NULL,
  gap_type            TEXT NOT NULL,
  lessons_planned     INT NOT NULL DEFAULT 0,
  lessons_delivered   INT NOT NULL DEFAULT 0,
  last_assessed_at    TIMESTAMPTZ,
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cur_gap_uq UNIQUE (unit_id, standard_id),
  CONSTRAINT cur_gap_type_chk CHECK (
    gap_type IN ('NOT_STARTED', 'PARTIAL', 'COMPLETE')
  ),
  CONSTRAINT cur_gap_counts_chk CHECK (
    lessons_planned >= 0 AND lessons_delivered >= 0
    AND lessons_delivered <= GREATEST(lessons_planned, lessons_delivered)
  ),
  CONSTRAINT cur_gap_unit_fk FOREIGN KEY (unit_id)
    REFERENCES cur_units(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cur_gap_type_idx
  ON cur_delivery_gaps (gap_type, computed_at DESC);

CREATE INDEX IF NOT EXISTS cur_gap_unit_idx
  ON cur_delivery_gaps (unit_id, gap_type);

COMMENT ON TABLE cur_delivery_gaps IS
  'Cycle 23 — MATERIALISED NIGHTLY per ADR-018. Never computed on demand. The Step 6 DeliveryGapService nightly worker walks each PUBLISHED curriculum maps unit + aligned standards, counts planned lessons (cur_unit_lessons) and delivered lessons (cls_lessons WHERE status=COMPLETED), and UPSERTs this row. 3-value gap_type CHECK NOT_STARTED / PARTIAL / COMPLETE. Emits cur.delivery_gap.detected for new NOT_STARTED or PARTIAL gaps on PUBLISHED maps.';

CREATE TABLE IF NOT EXISTS cur_resource_links (
  id               UUID PRIMARY KEY,
  unit_id          UUID NOT NULL,
  resource_type    TEXT NOT NULL,
  title            TEXT NOT NULL,
  description      TEXT,
  url              TEXT,
  s3_key           TEXT,
  is_teacher_only  BOOLEAN NOT NULL DEFAULT false,
  uploaded_by      UUID NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cur_resource_type_chk CHECK (
    resource_type IN ('FILE', 'URL', 'VIDEO', 'TEXTBOOK')
  ),
  CONSTRAINT cur_resource_target_chk CHECK (
    (resource_type IN ('URL', 'VIDEO') AND url IS NOT NULL)
    OR (resource_type IN ('FILE', 'TEXTBOOK'))
  ),
  CONSTRAINT cur_resource_unit_fk FOREIGN KEY (unit_id)
    REFERENCES cur_units(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cur_resource_unit_idx
  ON cur_resource_links (unit_id, resource_type);

CREATE INDEX IF NOT EXISTS cur_resource_teacher_only_idx
  ON cur_resource_links (unit_id) WHERE is_teacher_only = true;

COMMENT ON TABLE cur_resource_links IS
  'Cycle 23 — teaching resources per curriculum unit. 4-value resource_type CHECK FILE / URL / VIDEO / TEXTBOOK. Multi-column resource_target_chk requires url for URL+VIDEO types (FILE+TEXTBOOK can carry s3_key OR url OR neither for placeholder). is_teacher_only filters resources from non-staff readers at the Step 6 ResourceLinkService boundary.';
