-- Family structure — platform_person_relationships.
--
-- Biological, legal, and step-family relationships between people,
-- distinct from the household model. Stored bidirectionally (the app
-- layer auto-creates the reciprocal row); siblings are derived at read
-- time and never stored. See docs/campusos-family-structure-design.html.
--
-- related_person_id is NULLABLE: non-CampusOS people (deceased / absent
-- / never-joining parents) are captured by related_person_name instead.
-- The CHECK enforces that at least one of the two is present.
--
-- FK references to platform.iam_person are allowed here — the
-- ADR-001/020 soft-FK prohibition is about TENANT tables referencing
-- platform tables, not platform-internal references.

CREATE TABLE IF NOT EXISTS platform.platform_person_relationships (
  id                   UUID PRIMARY KEY,
  person_id            UUID NOT NULL REFERENCES platform.iam_person(id),
  related_person_id    UUID REFERENCES platform.iam_person(id),
  related_person_name  TEXT,
  relationship_type    TEXT NOT NULL,
  is_legal_custody     BOOLEAN NOT NULL DEFAULT false,
  custody_arrangement  TEXT,
  custody_notes        TEXT,
  is_primary_residence BOOLEAN NOT NULL DEFAULT false,
  verified             BOOLEAN NOT NULL DEFAULT false,
  verified_by          UUID REFERENCES platform.iam_person(id),
  verified_at          TIMESTAMPTZ,
  start_date           DATE,
  end_date             DATE,
  created_by           UUID NOT NULL REFERENCES platform.iam_person(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ
);

-- relationship_type enum (TEXT + CHECK per the P2-H4 ADV-06 ratification).
ALTER TABLE platform.platform_person_relationships
  DROP CONSTRAINT IF EXISTS platform_person_relationships_type_check;
ALTER TABLE platform.platform_person_relationships
  ADD CONSTRAINT platform_person_relationships_type_check
  CHECK (relationship_type IN (
    'BIOLOGICAL_MOTHER', 'BIOLOGICAL_FATHER', 'BIOLOGICAL_CHILD',
    'ADOPTIVE_MOTHER', 'ADOPTIVE_FATHER', 'ADOPTIVE_CHILD',
    'STEP_MOTHER', 'STEP_FATHER', 'STEP_CHILD',
    'LEGAL_GUARDIAN', 'LEGAL_WARD',
    'SPOUSE', 'DOMESTIC_PARTNER',
    'GRANDPARENT', 'GRANDCHILD'
  ));

-- custody_arrangement enum.
ALTER TABLE platform.platform_person_relationships
  DROP CONSTRAINT IF EXISTS platform_person_relationships_custody_check;
ALTER TABLE platform.platform_person_relationships
  ADD CONSTRAINT platform_person_relationships_custody_check
  CHECK (custody_arrangement IS NULL OR custody_arrangement IN (
    'FULL', 'JOINT', 'WEEKDAYS', 'WEEKENDS', 'SUMMERS', 'SUPERVISED', 'NONE'
  ));

-- No self-relationships.
ALTER TABLE platform.platform_person_relationships
  DROP CONSTRAINT IF EXISTS platform_person_relationships_not_self_check;
ALTER TABLE platform.platform_person_relationships
  ADD CONSTRAINT platform_person_relationships_not_self_check
  CHECK (person_id <> related_person_id);

-- At least one of related_person_id / related_person_name must be set.
ALTER TABLE platform.platform_person_relationships
  DROP CONSTRAINT IF EXISTS platform_person_relationships_related_present_check;
ALTER TABLE platform.platform_person_relationships
  ADD CONSTRAINT platform_person_relationships_related_present_check
  CHECK (related_person_id IS NOT NULL OR related_person_name IS NOT NULL);

-- Dedup: one relationship of a given type per (person, related CampusOS
-- person) pair. Partial because name-only rows have a NULL related id.
CREATE UNIQUE INDEX IF NOT EXISTS uq_person_relationships_linked
  ON platform.platform_person_relationships (person_id, related_person_id, relationship_type)
  WHERE related_person_id IS NOT NULL;

-- Dedup for name-only rows: one relationship of a given type per
-- (person, related name) pair.
CREATE UNIQUE INDEX IF NOT EXISTS uq_person_relationships_named
  ON platform.platform_person_relationships (person_id, related_person_name, relationship_type)
  WHERE related_person_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_person_relationships_person
  ON platform.platform_person_relationships (person_id);
CREATE INDEX IF NOT EXISTS idx_person_relationships_related
  ON platform.platform_person_relationships (related_person_id);
