/* 035_sis_student_active_accommodations.sql
 * Cycle 10 Step 4 prerequisite — ADR-030 IEP accommodation read model.
 *
 * The ADR-030 read model has been referenced in CLAUDE.md and prior
 * cycle handoffs since Cycle 1 as the surface teachers read to see
 * a student's active accommodations without ever touching hlth_*
 * tables. The table itself was never built. Cycle 10 Step 4 ships
 * it as a prerequisite for the Step 7 IepAccommodationConsumer
 * Kafka consumer, and the Step 4 seed plants two demo rows
 * (EXTENDED_TIME and REDUCED_DISTRACTION for Maya) so the read
 * model has a baseline shape.
 *
 *   sis_student_active_accommodations
 *     One denormalised row per (student, IEP accommodation source).
 *     The Step 7 IepPlanService emits iep.accommodation.updated on
 *     every INSERT / UPDATE / DELETE on hlth_iep_accommodations
 *     and the consumer upserts into this table keyed on
 *     source_iep_accommodation_id. Teachers read this table via
 *     the existing Cycle 1 student profile endpoint so they never
 *     touch hlth_* directly. The denormalised columns mirror
 *     hlth_iep_accommodations one-to-one plus plan_type for the
 *     UI badge and the source_iep_accommodation_id soft ref back
 *     to the source row.
 *
 * Schema design choices:
 *
 *   - applies_to and the matching multi-column applies_to_chk
 *     mirror the source table so the read model never holds a
 *     shape the source could not produce.
 *   - source_iep_accommodation_id is nullable to permit seed-time
 *     direct writes that demonstrate the read shape before any
 *     IEP accommodation row exists in the source table. UNIQUE
 *     on the column is enforced via partial UNIQUE INDEX
 *     WHERE source_iep_accommodation_id IS NOT NULL so the Step 7
 *     consumer can upsert deterministically while seed rows can
 *     coexist.
 *   - student_id FK CASCADE on sis_students follows the privacy
 *     convention: when a student is removed the read model goes
 *     with them.
 *
 * DB-enforced intra-tenant FKs (1 logical):
 *   sis_student_active_accommodations.student_id -> sis_students(id) CASCADE
 *
 * Soft cross-schema refs per ADR-001 / ADR-020:
 *   sis_student_active_accommodations.school_id -> platform.schools(id)
 *   sis_student_active_accommodations.source_iep_accommodation_id ->
 *     hlth_iep_accommodations(id) soft intra-tenant ref. Nullable so
 *     seed rows coexist with consumer-maintained rows. The consumer
 *     keys upserts by this column.
 *
 * 0 cross-schema FKs.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header, no semicolons inside any string literal or
 * comment per the splitter trap from Cycles 4 through 10.
 */

CREATE TABLE IF NOT EXISTS sis_student_active_accommodations (
  id                              UUID         PRIMARY KEY,
  school_id                       UUID         NOT NULL,
  student_id                      UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  plan_type                       TEXT         NOT NULL,
  accommodation_type              TEXT         NOT NULL,
  description                     TEXT,
  applies_to                      TEXT         NOT NULL,
  specific_assignment_types       TEXT[],
  effective_from                  DATE,
  effective_to                    DATE,
  source_iep_accommodation_id     UUID,
  created_at                      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT sis_student_active_accommodations_plan_type_chk
    CHECK (plan_type IN ('IEP', '504')),
  CONSTRAINT sis_student_active_accommodations_applies_to_chk
    CHECK (applies_to IN ('ALL_ASSESSMENTS', 'ALL_ASSIGNMENTS', 'SPECIFIC')),
  CONSTRAINT sis_student_active_accommodations_specific_chk
    CHECK (
      (applies_to <> 'SPECIFIC' AND specific_assignment_types IS NULL)
      OR
      (applies_to = 'SPECIFIC' AND specific_assignment_types IS NOT NULL AND cardinality(specific_assignment_types) > 0)
    ),
  CONSTRAINT sis_student_active_accommodations_dates_chk
    CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS sis_student_active_accommodations_student_idx
  ON sis_student_active_accommodations (student_id);

CREATE INDEX IF NOT EXISTS sis_student_active_accommodations_school_idx
  ON sis_student_active_accommodations (school_id);

CREATE UNIQUE INDEX IF NOT EXISTS sis_student_active_accommodations_source_uq
  ON sis_student_active_accommodations (source_iep_accommodation_id)
  WHERE source_iep_accommodation_id IS NOT NULL;

COMMENT ON TABLE sis_student_active_accommodations IS
  'ADR-030 read model. Denormalised view of active IEP / 504 accommodations populated by the Step 7 IepAccommodationConsumer. Teachers read this table via the Cycle 1 student profile endpoint so they never touch hlth_* tables directly. The applies_to and specific_assignment_types columns mirror hlth_iep_accommodations exactly so the read shape never diverges from the source.';

COMMENT ON COLUMN sis_student_active_accommodations.source_iep_accommodation_id IS
  'Soft ref to hlth_iep_accommodations(id). Nullable so seed-time direct writes can demonstrate the read shape before any IEP accommodation row exists. The Step 7 consumer keys upserts by this column via the partial UNIQUE INDEX. Per ADR-001 / ADR-020 the ref is intra-tenant but kept soft so retracting an IEP accommodation does not cascade into the read model.';

COMMENT ON CONSTRAINT sis_student_active_accommodations_specific_chk ON sis_student_active_accommodations IS
  'Mirrors the source hlth_iep_accommodations applies_to_chk. SPECIFIC requires a non-empty specific_assignment_types array. ALL_ASSESSMENTS and ALL_ASSIGNMENTS require the array to be NULL.';
