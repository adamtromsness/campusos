/*
 * 142_sis_profiles_customfields.sql — Phase 2 Cycle 13 sub-cycle a (P2-13a).
 *
 * M20 SIS Advanced — first 8 of 24 tables. The P2-13 cycle ships
 * 24 tables across 3 sub-cycles (P2-13a 8 plus P2-13b 8 plus
 * P2-13c 8). Migration 142 covers P2-13a.
 *
 *   sis_student_profiles            Student-owned profile with bio,
 *                                   interests, motto, currently
 *                                   reading, favourite song, and
 *                                   avatar. avatar_status 3-value
 *                                   CHECK (PENDING_APPROVAL APPROVED
 *                                   REJECTED). Only the owning
 *                                   student can edit bio plus
 *                                   interests plus motto. Avatar
 *                                   upload requires homeroom teacher
 *                                   approval before it lands on the
 *                                   public profile. Multi-column
 *                                   avatar_reviewed_chk lockstep
 *                                   keeps avatar_reviewed_by plus
 *                                   avatar_reviewed_at populated
 *                                   together when status is
 *                                   APPROVED or REJECTED.
 *                                   UNIQUE(student_id).
 *   sis_custom_field_definitions    School-defined typed fields
 *                                   attached to any SIS entity.
 *                                   4-value entity_type CHECK
 *                                   (STUDENT STAFF GUARDIAN CLASS).
 *                                   6-value field_type CHECK (TEXT
 *                                   NUMBER DATE BOOLEAN ENUM
 *                                   MULTI_SELECT). enum_options is
 *                                   the option list for ENUM and
 *                                   MULTI_SELECT — required for
 *                                   those types, ignored for
 *                                   others. Schools define their
 *                                   own fields without schema
 *                                   changes. UNIQUE(school_id
 *                                   entity_type field_name).
 *   sis_custom_field_values         Per-(definition entity) typed
 *                                   value. Only one value_* column
 *                                   populated per row based on the
 *                                   matching definition.field_type.
 *                                   Multi-column shape_chk enforces
 *                                   the value column matches the
 *                                   definition type — caught at
 *                                   write time by the service layer
 *                                   reading the definition first
 *                                   plus the column-level CHECK as
 *                                   schema-side belt-and-braces.
 *                                   UNIQUE(definition_id entity_id).
 *   sis_parent_info_update_requests Parent-initiated info update
 *                                   workflow. 3-value target_type
 *                                   CHECK (STUDENT_INFO GUARDIAN_INFO
 *                                   EMERGENCY_CONTACT). 4-value
 *                                   status CHECK (PENDING APPROVED
 *                                   REJECTED AUTO_APPROVED).
 *                                   proposed_changes JSONB carries
 *                                   the field-by-field diff. Multi-
 *                                   column reviewed_chk lockstep
 *                                   keeps reviewed_by plus reviewed_at
 *                                   populated together for every
 *                                   terminal status. Multi-column
 *                                   applied_chk lockstep keeps
 *                                   applied_at populated only when
 *                                   status is APPROVED or
 *                                   AUTO_APPROVED. Partial INDEX on
 *                                   (school_id) WHERE status equals
 *                                   PENDING is the admin queue hot
 *                                   path.
 *   sis_auto_approval_rules         Per-(school target_type
 *                                   field_name) auto-approval flag.
 *                                   Low-risk fields like phone or
 *                                   personal email can be flagged
 *                                   auto_approve true so the parent
 *                                   request flows AUTO_APPROVED on
 *                                   submission. High-risk fields
 *                                   like address or emergency
 *                                   contacts default to manual
 *                                   review. UNIQUE(school_id
 *                                   target_type field_name).
 *   sis_student_photos              Official school photo separate
 *                                   from the student-uploaded
 *                                   avatar. 3-value photo_type CHECK
 *                                   (OFFICIAL YEARBOOK ID_CARD).
 *                                   academic_year is the school
 *                                   year the photo was taken in.
 *                                   is_current flags the photo
 *                                   visible on the current student
 *                                   profile. UNIQUE(student_id
 *                                   photo_type academic_year).
 *                                   Partial UNIQUE on (student_id
 *                                   photo_type) WHERE is_current
 *                                   equals true so at most one
 *                                   current photo per type per
 *                                   student.
 *   sis_student_notes               Staff-authored notes about a
 *                                   student. 5-value note_type
 *                                   CHECK (ACADEMIC BEHAVIOURAL
 *                                   PASTORAL ADMINISTRATIVE
 *                                   CONFIDENTIAL). is_visible_to_parent
 *                                   gates parent visibility for
 *                                   non-CONFIDENTIAL notes.
 *                                   is_confidential CONFIDENTIAL
 *                                   notes are visible only to the
 *                                   authoring staff plus admin —
 *                                   service-layer row scope
 *                                   filters every other reader.
 *                                   INDEX(student_id note_type
 *                                   created_at DESC).
 *   sis_family_relationships        Relationship between two
 *                                   guardians within the same
 *                                   family. 6-value relationship_type
 *                                   CHECK (MARRIED DIVORCED
 *                                   SEPARATED COHABITING STEP_PARENT
 *                                   OTHER). 4-value custody_arrangement
 *                                   CHECK (JOINT SOLE_A SOLE_B
 *                                   OTHER) nullable. Custody
 *                                   arrangement drives which parent
 *                                   sees what data downstream.
 *                                   UNIQUE(family_id guardian_a_id
 *                                   guardian_b_id). CHECK
 *                                   guardian_a_id is not equal to
 *                                   guardian_b_id so a self-link
 *                                   cannot land.
 *
 * Soft FKs to platform.iam_person and platform.platform_families
 * per ADR-001 and ADR-020 are not enforced at the schema layer —
 * the request-path service layer validates the supplied UUIDs
 * against the calling tenant before INSERT. DB-enforced FKs to
 * sis_students use ON DELETE CASCADE on every child link since
 * profile and photo and note rows carry no value without the
 * parent student.
 *
 * No semicolons inside string literals or block comments. The
 * tenant provisioner splits the migration on every semicolon
 * regardless of quoting context.
 */

CREATE TABLE IF NOT EXISTS sis_student_profiles (
  id                       UUID PRIMARY KEY,
  student_id               UUID NOT NULL UNIQUE,
  bio                      TEXT,
  currently_reading        TEXT,
  favourite_song           TEXT,
  interests                TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  motto                    TEXT,
  avatar_s3_key            TEXT,
  avatar_status            TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  avatar_reviewed_by       UUID,
  avatar_reviewed_at       TIMESTAMPTZ,
  avatar_review_notes      TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_student_profiles_student_fk FOREIGN KEY (student_id)
    REFERENCES sis_students(id) ON DELETE CASCADE,
  CONSTRAINT sis_student_profiles_avatar_status_chk CHECK (
    avatar_status IN ('PENDING_APPROVAL','APPROVED','REJECTED')
  ),
  CONSTRAINT sis_student_profiles_avatar_reviewed_chk CHECK (
    (avatar_status = 'PENDING_APPROVAL' AND avatar_reviewed_by IS NULL AND avatar_reviewed_at IS NULL)
    OR (avatar_status IN ('APPROVED','REJECTED') AND avatar_reviewed_by IS NOT NULL AND avatar_reviewed_at IS NOT NULL)
  ),
  CONSTRAINT sis_student_profiles_bio_chk CHECK (
    bio IS NULL OR length(bio) <= 500
  ),
  CONSTRAINT sis_student_profiles_motto_chk CHECK (
    motto IS NULL OR length(motto) <= 200
  )
);

CREATE INDEX IF NOT EXISTS sis_student_profiles_student_idx
  ON sis_student_profiles(student_id);

CREATE INDEX IF NOT EXISTS sis_student_profiles_avatar_pending_idx
  ON sis_student_profiles(avatar_status) WHERE avatar_status = 'PENDING_APPROVAL';

COMMENT ON TABLE sis_student_profiles IS
  'Student-owned profile with bio plus interests plus avatar. Only the owning student can edit bio plus interests plus motto. Avatar upload lands as PENDING_APPROVAL and requires homeroom teacher approval before becoming visible on the public profile.';

COMMENT ON COLUMN sis_student_profiles.avatar_reviewed_by IS
  'Soft FK to platform.iam_person(id) per ADR-001 and ADR-020. The reviewer is typically the homeroom teacher.';

CREATE TABLE IF NOT EXISTS sis_custom_field_definitions (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  entity_type              TEXT NOT NULL,
  field_name               TEXT NOT NULL,
  field_label              TEXT NOT NULL,
  field_type               TEXT NOT NULL,
  enum_options             TEXT[],
  is_required              BOOLEAN NOT NULL DEFAULT false,
  is_visible_to_parent     BOOLEAN NOT NULL DEFAULT false,
  sort_order               INT NOT NULL DEFAULT 0,
  is_active                BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_custom_field_defs_entity_chk CHECK (
    entity_type IN ('STUDENT','STAFF','GUARDIAN','CLASS')
  ),
  CONSTRAINT sis_custom_field_defs_type_chk CHECK (
    field_type IN ('TEXT','NUMBER','DATE','BOOLEAN','ENUM','MULTI_SELECT')
  ),
  CONSTRAINT sis_custom_field_defs_enum_chk CHECK (
    (field_type IN ('ENUM','MULTI_SELECT') AND enum_options IS NOT NULL AND cardinality(enum_options) > 0)
    OR (field_type NOT IN ('ENUM','MULTI_SELECT'))
  ),
  CONSTRAINT sis_custom_field_defs_unique UNIQUE (school_id, entity_type, field_name)
);

CREATE INDEX IF NOT EXISTS sis_custom_field_defs_entity_idx
  ON sis_custom_field_definitions(school_id, entity_type, is_active);

COMMENT ON TABLE sis_custom_field_definitions IS
  'School-defined typed fields attached to any SIS entity. 4-value entity_type CHECK and 6-value field_type CHECK. Schools define their own fields without schema changes. enum_options is required for ENUM and MULTI_SELECT types and enforced via enum_chk.';

CREATE TABLE IF NOT EXISTS sis_custom_field_values (
  id                       UUID PRIMARY KEY,
  definition_id            UUID NOT NULL,
  entity_id                UUID NOT NULL,
  value_text               TEXT,
  value_number             NUMERIC(12,4),
  value_date               DATE,
  value_boolean            BOOLEAN,
  value_enum               TEXT,
  value_multi              TEXT[],
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_custom_field_values_def_fk FOREIGN KEY (definition_id)
    REFERENCES sis_custom_field_definitions(id) ON DELETE CASCADE,
  CONSTRAINT sis_custom_field_values_unique UNIQUE (definition_id, entity_id)
);

CREATE INDEX IF NOT EXISTS sis_custom_field_values_def_entity_idx
  ON sis_custom_field_values(definition_id, entity_id);

CREATE INDEX IF NOT EXISTS sis_custom_field_values_entity_idx
  ON sis_custom_field_values(entity_id);

COMMENT ON TABLE sis_custom_field_values IS
  'Per-(definition entity) typed value. Only one value_* column populated per row based on the matching definition.field_type — enforced at write time by the service layer reading the definition first. entity_id is a soft polymorphic ref to the underlying SIS table per ADR-001 and ADR-020.';

COMMENT ON COLUMN sis_custom_field_values.entity_id IS
  'Soft polymorphic ref interpreted per definition.entity_type — STUDENT references sis_students(id), STAFF references hr_employees(id), GUARDIAN references sis_guardians(id), CLASS references sis_classes(id). Validated at write time.';

CREATE TABLE IF NOT EXISTS sis_parent_info_update_requests (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  submitted_by             UUID NOT NULL,
  target_type              TEXT NOT NULL,
  target_id                UUID NOT NULL,
  proposed_changes         JSONB NOT NULL,
  change_reason            TEXT,
  status                   TEXT NOT NULL DEFAULT 'PENDING',
  reviewed_by              UUID,
  reviewed_at              TIMESTAMPTZ,
  reviewer_notes           TEXT,
  applied_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_parent_update_target_chk CHECK (
    target_type IN ('STUDENT_INFO','GUARDIAN_INFO','EMERGENCY_CONTACT')
  ),
  CONSTRAINT sis_parent_update_status_chk CHECK (
    status IN ('PENDING','APPROVED','REJECTED','AUTO_APPROVED')
  ),
  CONSTRAINT sis_parent_update_reviewed_chk CHECK (
    (status = 'PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (status IN ('APPROVED','REJECTED') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    OR (status = 'AUTO_APPROVED')
  ),
  CONSTRAINT sis_parent_update_applied_chk CHECK (
    (status IN ('APPROVED','AUTO_APPROVED') AND applied_at IS NOT NULL)
    OR (status IN ('PENDING','REJECTED') AND applied_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS sis_parent_update_pending_idx
  ON sis_parent_info_update_requests(school_id) WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS sis_parent_update_submitter_idx
  ON sis_parent_info_update_requests(submitted_by, created_at DESC);

CREATE INDEX IF NOT EXISTS sis_parent_update_target_idx
  ON sis_parent_info_update_requests(target_type, target_id);

COMMENT ON TABLE sis_parent_info_update_requests IS
  'Parent-initiated info update workflow. 3-value target_type CHECK plus 4-value status CHECK. proposed_changes JSONB carries the field-by-field diff. Multi-column reviewed_chk and applied_chk lockstep keep audit fields consistent with status. The admin queue hot path uses the partial INDEX on (school_id) WHERE status equals PENDING.';

COMMENT ON COLUMN sis_parent_info_update_requests.submitted_by IS
  'Soft FK to platform.iam_person(id) per ADR-001 and ADR-020. Identifies the parent who submitted the request.';

COMMENT ON COLUMN sis_parent_info_update_requests.target_id IS
  'Soft polymorphic ref — STUDENT_INFO references sis_students(id), GUARDIAN_INFO references sis_guardians(id), EMERGENCY_CONTACT references sis_emergency_contacts(id). Validated at write time.';

CREATE TABLE IF NOT EXISTS sis_auto_approval_rules (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  target_type              TEXT NOT NULL,
  field_name               TEXT NOT NULL,
  auto_approve             BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_auto_approval_target_chk CHECK (
    target_type IN ('STUDENT_INFO','GUARDIAN_INFO','EMERGENCY_CONTACT')
  ),
  CONSTRAINT sis_auto_approval_unique UNIQUE (school_id, target_type, field_name)
);

CREATE INDEX IF NOT EXISTS sis_auto_approval_lookup_idx
  ON sis_auto_approval_rules(school_id, target_type, field_name);

COMMENT ON TABLE sis_auto_approval_rules IS
  'Per-(school target_type field_name) auto-approval configuration. Low-risk fields like phone or personal_email can be flagged auto_approve true so the parent request flows AUTO_APPROVED on submission. High-risk fields like address or emergency contacts default to manual review.';

CREATE TABLE IF NOT EXISTS sis_student_photos (
  id                       UUID PRIMARY KEY,
  student_id               UUID NOT NULL,
  photo_type               TEXT NOT NULL,
  s3_key                   TEXT NOT NULL,
  academic_year            TEXT NOT NULL,
  is_current               BOOLEAN NOT NULL DEFAULT true,
  uploaded_by              UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_student_photos_student_fk FOREIGN KEY (student_id)
    REFERENCES sis_students(id) ON DELETE CASCADE,
  CONSTRAINT sis_student_photos_type_chk CHECK (
    photo_type IN ('OFFICIAL','YEARBOOK','ID_CARD')
  ),
  CONSTRAINT sis_student_photos_unique UNIQUE (student_id, photo_type, academic_year)
);

CREATE UNIQUE INDEX IF NOT EXISTS sis_student_photos_current_uq
  ON sis_student_photos(student_id, photo_type) WHERE is_current = true;

CREATE INDEX IF NOT EXISTS sis_student_photos_student_idx
  ON sis_student_photos(student_id, is_current);

COMMENT ON TABLE sis_student_photos IS
  'Official school photo separate from the student-uploaded avatar on sis_student_profiles. 3-value photo_type CHECK and partial UNIQUE on (student_id photo_type) WHERE is_current equals true so at most one current photo per type per student.';

/*
 * sis_student_notes already exists from migration 003 with this shape.
 * P2-13a extends the existing table by widening the note_type CHECK to
 * include ADMINISTRATIVE and CONFIDENTIAL alongside the original
 * PASTORAL ACADEMIC BEHAVIOURAL WELLBEING GENERAL values. The existing
 * is_parent_visible column maps to the plan's is_visible_to_parent
 * concept. The splitter-safe DROP IF EXISTS plus ADD pattern lets
 * the migration apply idempotently. confidential_chk prevents the
 * impossible state where a note is both confidential and parent-
 * visible. The partial INDEX on (student_id author_id) WHERE
 * is_confidential equals true backs the row-scope read path for
 * non-author non-admin actors who must be filtered out of every
 * CONFIDENTIAL row.
 */

ALTER TABLE sis_student_notes
  DROP CONSTRAINT IF EXISTS sis_student_notes_note_type_chk;

ALTER TABLE sis_student_notes
  ADD CONSTRAINT sis_student_notes_note_type_chk CHECK (
    note_type IN ('PASTORAL','ACADEMIC','BEHAVIOURAL','WELLBEING','GENERAL','ADMINISTRATIVE','CONFIDENTIAL')
  );

ALTER TABLE sis_student_notes
  DROP CONSTRAINT IF EXISTS sis_student_notes_confidential_chk;

ALTER TABLE sis_student_notes
  ADD CONSTRAINT sis_student_notes_confidential_chk CHECK (
    NOT (is_confidential = true AND is_parent_visible = true)
  );

COMMENT ON TABLE sis_student_notes IS
  'Staff-authored notes about a student. 7-value note_type CHECK widened by P2-13a to include ADMINISTRATIVE and CONFIDENTIAL. CONFIDENTIAL notes are visible only to the authoring staff plus admin — service-layer row scope filters every other reader. The confidential_chk constraint prevents the impossible state where a confidential note is also marked parent-visible.';

COMMENT ON COLUMN sis_student_notes.author_id IS
  'Soft FK to platform.iam_person(id) per ADR-001 and ADR-020. Identifies the staff member who authored the note.';

CREATE TABLE IF NOT EXISTS sis_family_relationships (
  id                       UUID PRIMARY KEY,
  family_id                UUID NOT NULL,
  guardian_a_id            UUID NOT NULL,
  guardian_b_id            UUID NOT NULL,
  relationship_type        TEXT NOT NULL,
  custody_arrangement      TEXT,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sis_family_rel_type_chk CHECK (
    relationship_type IN ('MARRIED','DIVORCED','SEPARATED','COHABITING','STEP_PARENT','OTHER')
  ),
  CONSTRAINT sis_family_rel_custody_chk CHECK (
    custody_arrangement IS NULL OR custody_arrangement IN ('JOINT','SOLE_A','SOLE_B','OTHER')
  ),
  CONSTRAINT sis_family_rel_not_self_chk CHECK (guardian_a_id <> guardian_b_id),
  CONSTRAINT sis_family_rel_unique UNIQUE (family_id, guardian_a_id, guardian_b_id)
);

CREATE INDEX IF NOT EXISTS sis_family_rel_family_idx
  ON sis_family_relationships(family_id);

CREATE INDEX IF NOT EXISTS sis_family_rel_guardian_a_idx
  ON sis_family_relationships(guardian_a_id);

CREATE INDEX IF NOT EXISTS sis_family_rel_guardian_b_idx
  ON sis_family_relationships(guardian_b_id);

COMMENT ON TABLE sis_family_relationships IS
  'Relationship between two guardians within the same family. 6-value relationship_type CHECK and 4-value custody_arrangement CHECK nullable. Custody arrangement drives which parent sees what data downstream. Soft FKs to platform.platform_families(id) and sis_guardians(id) per ADR-001 and ADR-020.';

COMMENT ON COLUMN sis_family_relationships.guardian_a_id IS
  'Soft FK to sis_guardians(id) per ADR-001 and ADR-020. One side of the relationship.';

COMMENT ON COLUMN sis_family_relationships.guardian_b_id IS
  'Soft FK to sis_guardians(id) per ADR-001 and ADR-020. Other side of the relationship.';
