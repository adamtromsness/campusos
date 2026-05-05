/* 045_lib_reading_reviews.sql
 * Cycle 12 Step 3 — M24 Library reading programmes, reading lists,
 * and student book reviews.
 *
 * Seven new tenant base tables completing the Cycle 12 schema phase
 * at 14 lib_* tables across migrations 043 + 044 + 045. The Step 7
 * ReadingProgrammeService is the canonical writer for programmes and
 * the per-student progress + completion award rows. The Step 7
 * ReadingLogService is the canonical writer for the student-facing
 * reading log — the second student-input surface in CampusOS after
 * Cycle 11.1 wellbeing check-ins. The Step 7 ReadingListService is
 * the canonical writer for librarian + teacher curated reading lists.
 * The Step 7 ReviewService is the canonical writer for student book
 * reviews.
 *
 *   lib_reading_programmes     Reading programme definition. target
 *                              audience_type is a 4-value enum CHECK
 *                              SCHOOL_WIDE, YEAR_GROUP, CLASS, CUSTOM
 *                              with soft polymorphic target_id (sis
 *                              classes for CLASS, year-group label
 *                              for YEAR_GROUP, list of student ids
 *                              for CUSTOM, NULL for SCHOOL_WIDE).
 *                              target_books and target_pages are
 *                              both nullable so a programme can use
 *                              either or both metrics. is_active flag
 *                              for soft deactivation.
 *
 *   lib_reading_logs           Student-reported reading entries. The
 *                              SECOND STUDENT-INPUT SURFACE in
 *                              CampusOS after Cycle 11.1 wellbeing
 *                              check-ins. student_id CASCADE since
 *                              the log is personal student data.
 *                              catalogue_item_id NO ACTION refuses
 *                              hard-delete of a catalogue item while
 *                              students have logged it (preserves
 *                              the personal reading history). pages
 *                              read >= 0 CHECK. rating SMALLINT
 *                              nullable with 1..5 CHECK when set.
 *                              On completed_date set the Step 7
 *                              service auto-upserts the matching
 *                              programme_progress row if an active
 *                              programme covers this student.
 *
 *   lib_programme_progress     Per-(programme, student) running
 *                              totals. UNIQUE(programme_id, student
 *                              id) so each student has exactly one
 *                              progress row per programme. books
 *                              read and pages_read both non-negative
 *                              CHECKs. is_complete flag set to true
 *                              when the running total reaches the
 *                              programme target. The Step 7 service
 *                              emits lib.programme.completed on the
 *                              flip to true (deferred to a future
 *                              cycle along with a corresponding Task
 *                              Worker auto-task rule).
 *
 *   lib_programme_completions  Award record. UNIQUE(programme_id,
 *                              student_id) one award per student per
 *                              programme. completed_at NOT NULL and
 *                              books_read NOT NULL + pages_read NOT
 *                              NULL captures the snapshot at award
 *                              time so a later progress edit does
 *                              not retroactively change the award.
 *                              certificate_s3_key nullable until the
 *                              future certificate-generation worker
 *                              materialises the PDF. awarded_by SET
 *                              NULL on hr_employees delete (audit
 *                              outlives the awarding librarian).
 *                              achievement_id soft to a future
 *                              pfl_achievements table.
 *
 *   lib_reading_lists          Curated booklist. list_type is a
 *                              5-value enum CHECK CLASS, YEAR_GROUP,
 *                              CURRICULUM_UNIT, GENERAL, NEW_ARRIVALS.
 *                              created_by NO ACTION because list
 *                              authorship has audit value beyond the
 *                              creator leaving. target_class_id soft
 *                              to sis_classes (no DB FK). academic
 *                              year_id nullable for evergreen lists.
 *                              UNIQUE(school_id, name, COALESCE
 *                              academic_year_id sentinel) so a name
 *                              is unique per (school, year) including
 *                              the no-year case. is_published flag
 *                              with multi-column published_chk
 *                              keeping is_published in lockstep with
 *                              published_at — the Step 7 service
 *                              stamps both atomically on publish and
 *                              clears both atomically on unpublish.
 *
 *   lib_reading_list_items     Items inside a reading list. item
 *                              type is a 4-value enum CHECK REQUIRED,
 *                              RECOMMENDED, EXTENSION, REFERENCE.
 *                              UNIQUE(reading_list_id, catalogue
 *                              item_id) so an item appears at most
 *                              once per list. CASCADE on parent list
 *                              delete because list items are
 *                              meaningless without their list. NO
 *                              ACTION on catalogue_item_id to refuse
 *                              item delete while reading lists
 *                              reference it. added_by NO ACTION
 *                              audit ref. sort_order non-negative.
 *
 *   lib_reviews                Student book reviews. UNIQUE(item_id,
 *                              student_id) means each student gets
 *                              one review per item. PATCH rather than
 *                              re-POST for edits. rating 1..5 CHECK
 *                              required. is_approved flag for the
 *                              librarian to hide inappropriate
 *                              reviews via is_approved=false (soft
 *                              hide that preserves the row for audit).
 *                              student_id CASCADE since reviews are
 *                              personal student data. item_id NO
 *                              ACTION refuses item delete with
 *                              reviews — the librarian must clean up
 *                              reviews first or use the soft-delete
 *                              path on lib_catalogue_copies.
 *
 * Soft cross-schema refs per ADR-001 / ADR-020:
 *   lib_reading_programmes.school_id  -> platform.schools(id)
 *   lib_reading_programmes.target_id  -> polymorphic by target_audience_type
 *   lib_reading_lists.school_id       -> platform.schools(id)
 *   lib_reading_lists.target_class_id -> sis_classes(id) optional
 *   lib_programme_completions.achievement_id -> future pfl_achievements(id) optional
 *
 * DB-enforced intra-tenant FKs (15 logical):
 *   lib_reading_programmes.academic_year_id   -> sis_academic_years(id) NO ACTION
 *   lib_reading_logs.student_id               -> sis_students(id) CASCADE
 *   lib_reading_logs.catalogue_item_id        -> lib_catalogue_items(id) NO ACTION
 *   lib_programme_progress.programme_id       -> lib_reading_programmes(id) CASCADE
 *   lib_programme_progress.student_id         -> sis_students(id) CASCADE
 *   lib_programme_completions.programme_id    -> lib_reading_programmes(id) NO ACTION
 *   lib_programme_completions.student_id      -> sis_students(id) CASCADE
 *   lib_programme_completions.awarded_by      -> hr_employees(id) SET NULL
 *   lib_reading_lists.created_by              -> hr_employees(id) NO ACTION
 *   lib_reading_lists.academic_year_id        -> sis_academic_years(id) NO ACTION (nullable)
 *   lib_reading_list_items.reading_list_id    -> lib_reading_lists(id) CASCADE
 *   lib_reading_list_items.catalogue_item_id  -> lib_catalogue_items(id) NO ACTION
 *   lib_reading_list_items.added_by           -> hr_employees(id) NO ACTION
 *   lib_reviews.item_id                       -> lib_catalogue_items(id) NO ACTION
 *   lib_reviews.student_id                    -> sis_students(id) CASCADE
 *
 * 0 cross-schema FKs.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header, no semicolons inside any string literal or
 * comment per the splitter trap from Cycles 4 through 12.
 */

CREATE TABLE IF NOT EXISTS lib_reading_programmes (
  id                      UUID         PRIMARY KEY,
  school_id               UUID         NOT NULL,
  name                    TEXT         NOT NULL,
  description             TEXT,
  academic_year_id        UUID         REFERENCES sis_academic_years(id),
  target_books            INT,
  target_pages            INT,
  start_date              DATE,
  end_date                DATE,
  is_active               BOOLEAN      NOT NULL DEFAULT true,
  target_audience_type    TEXT         NOT NULL DEFAULT 'SCHOOL_WIDE',
  target_id               UUID,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT lib_programmes_audience_chk
    CHECK (target_audience_type IN ('SCHOOL_WIDE', 'YEAR_GROUP', 'CLASS', 'CUSTOM')),
  CONSTRAINT lib_programmes_target_books_chk
    CHECK (target_books IS NULL OR target_books >= 0),
  CONSTRAINT lib_programmes_target_pages_chk
    CHECK (target_pages IS NULL OR target_pages >= 0),
  CONSTRAINT lib_programmes_dates_chk
    CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS lib_programmes_school_active_idx
  ON lib_reading_programmes (school_id, is_active);

CREATE INDEX IF NOT EXISTS lib_programmes_year_idx
  ON lib_reading_programmes (academic_year_id)
  WHERE academic_year_id IS NOT NULL;

COMMENT ON TABLE lib_reading_programmes IS
  'Reading programme definition. The Step 7 ReadingProgrammeService is the canonical writer. target_audience_type is a 4-value enum and target_id is the soft polymorphic target — sis_classes(id) for CLASS, year-group label encoded as UUID for YEAR_GROUP, NULL for SCHOOL_WIDE, and a CUSTOM list resolved app-side for CUSTOM. target_books and target_pages are both nullable so a programme can use either or both metrics for the completion rule.';

COMMENT ON COLUMN lib_reading_programmes.target_id IS
  'Soft polymorphic ref interpreted by the Step 7 service per target_audience_type. NULL for SCHOOL_WIDE. sis_classes(id) for CLASS. Year-group label for YEAR_GROUP. The Step 7 service walks the resolution at programme-progress upsert time when a student logs a book.';

CREATE TABLE IF NOT EXISTS lib_reading_logs (
  id                  UUID         PRIMARY KEY,
  student_id          UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  catalogue_item_id   UUID         NOT NULL REFERENCES lib_catalogue_items(id),
  started_date        DATE,
  completed_date      DATE,
  pages_read          INT,
  rating              SMALLINT,
  review_text         TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT lib_logs_pages_chk
    CHECK (pages_read IS NULL OR pages_read >= 0),
  CONSTRAINT lib_logs_rating_chk
    CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
  CONSTRAINT lib_logs_dates_chk
    CHECK (started_date IS NULL OR completed_date IS NULL OR completed_date >= started_date)
);

CREATE INDEX IF NOT EXISTS lib_logs_student_completed_idx
  ON lib_reading_logs (student_id, completed_date DESC);

CREATE INDEX IF NOT EXISTS lib_logs_item_idx
  ON lib_reading_logs (catalogue_item_id);

COMMENT ON TABLE lib_reading_logs IS
  'Student-reported reading entries. THE SECOND STUDENT-INPUT SURFACE in CampusOS after Cycle 11.1 wellbeing check-ins. The Step 7 ReadingLogService is the canonical writer. CASCADE on student_id because reading logs are personal student data and follow the student through deletion. NO ACTION on catalogue_item_id refuses hard-delete of a catalogue item while logs reference it — the librarian must run the soft-delete path on lib_catalogue_copies or clear logs first. On completed_date set the service auto-upserts the matching lib_programme_progress row when an active programme covers the student.';

COMMENT ON COLUMN lib_reading_logs.rating IS
  'SMALLINT 1..5 CHECK. Nullable so a student can log an in-progress read without yet rating. The student-facing UI surfaces 5 emoji stars and writes 1..5 here.';

CREATE TABLE IF NOT EXISTS lib_programme_progress (
  id                  UUID         PRIMARY KEY,
  programme_id        UUID         NOT NULL REFERENCES lib_reading_programmes(id) ON DELETE CASCADE,
  student_id          UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  books_read          INT          NOT NULL DEFAULT 0,
  pages_read          INT          NOT NULL DEFAULT 0,
  last_updated_at     TIMESTAMPTZ,
  is_complete         BOOLEAN      NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT lib_progress_books_chk
    CHECK (books_read >= 0),
  CONSTRAINT lib_progress_pages_chk
    CHECK (pages_read >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS lib_progress_programme_student_uq
  ON lib_programme_progress (programme_id, student_id);

CREATE INDEX IF NOT EXISTS lib_progress_programme_idx
  ON lib_programme_progress (programme_id, is_complete);

COMMENT ON TABLE lib_programme_progress IS
  'Per-(programme, student) running totals. UNIQUE(programme_id, student_id) so each student has exactly one progress row per programme. The Step 7 ReadingLogService upserts this row on every reading log completed_date set. CASCADE on both parents because a programme delete drops every per-student progress row, and a student delete drops their progress everywhere.';

CREATE TABLE IF NOT EXISTS lib_programme_completions (
  id                  UUID         PRIMARY KEY,
  programme_id        UUID         NOT NULL REFERENCES lib_reading_programmes(id),
  student_id          UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  completed_at        TIMESTAMPTZ  NOT NULL,
  books_read          INT          NOT NULL,
  pages_read          INT          NOT NULL,
  certificate_s3_key  TEXT,
  awarded_by          UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  achievement_id      UUID,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT lib_completions_books_chk
    CHECK (books_read >= 0),
  CONSTRAINT lib_completions_pages_chk
    CHECK (pages_read >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS lib_completions_programme_student_uq
  ON lib_programme_completions (programme_id, student_id);

CREATE INDEX IF NOT EXISTS lib_completions_student_idx
  ON lib_programme_completions (student_id, completed_at DESC);

COMMENT ON TABLE lib_programme_completions IS
  'Award record. UNIQUE(programme_id, student_id) one award per student per programme. completed_at + books_read + pages_read are NOT NULL because the row captures the snapshot at award time — a later edit on lib_programme_progress does not retroactively change the award. NO ACTION on programme_id preserves the award even when a programme is removed (audit). CASCADE on student_id because awards follow the student. SET NULL on awarded_by since the audit outlives the awarding librarian. achievement_id is a soft optional UUID for the future pfl_achievements integration.';

COMMENT ON COLUMN lib_programme_completions.certificate_s3_key IS
  'NULL until the future certificate-generation worker materialises the PDF and writes the S3 key here. The Step 7 service does not block award creation on the certificate path so the worker can run async.';

CREATE TABLE IF NOT EXISTS lib_reading_lists (
  id                  UUID         PRIMARY KEY,
  school_id           UUID         NOT NULL,
  name                TEXT         NOT NULL,
  description         TEXT,
  list_type           TEXT         NOT NULL,
  created_by          UUID         NOT NULL REFERENCES hr_employees(id),
  target_class_id     UUID,
  academic_year_id    UUID         REFERENCES sis_academic_years(id),
  is_published        BOOLEAN      NOT NULL DEFAULT false,
  published_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT lib_lists_type_chk
    CHECK (list_type IN ('CLASS', 'YEAR_GROUP', 'CURRICULUM_UNIT', 'GENERAL', 'NEW_ARRIVALS')),
  CONSTRAINT lib_lists_published_chk
    CHECK (
      (is_published = true AND published_at IS NOT NULL)
      OR
      (is_published = false AND published_at IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS lib_lists_school_name_year_uq
  ON lib_reading_lists (
    school_id,
    name,
    COALESCE(academic_year_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS lib_lists_school_published_idx
  ON lib_reading_lists (school_id, is_published);

CREATE INDEX IF NOT EXISTS lib_lists_class_idx
  ON lib_reading_lists (target_class_id)
  WHERE target_class_id IS NOT NULL;

COMMENT ON TABLE lib_reading_lists IS
  'Curated booklist. The Step 7 ReadingListService is the canonical writer. UNIQUE(school_id, name, COALESCE(academic_year_id, sentinel)) so a list name is unique per (school, year) — the COALESCE-sentinel pattern matches Cycle 6 enr_intake_capacities and Cycle 5 sch_periods because Postgres treats NULL != NULL in UNIQUE by default and we want exactly-one-row-per-(school, name, NULL-year). The multi-column published_chk pins is_published to lockstep with published_at — the Step 7 service stamps both atomically on publish and clears both on unpublish.';

COMMENT ON COLUMN lib_reading_lists.list_type IS
  'CLASS for a teacher-created class-specific list (target_class_id populated). YEAR_GROUP for grade-level reading. CURRICULUM_UNIT for a topical unit booklist. GENERAL for librarian-curated thematic recommendations. NEW_ARRIVALS for the recently-added-to-catalogue display.';

COMMENT ON COLUMN lib_reading_lists.target_class_id IS
  'Soft UUID ref to sis_classes(id). Populated when list_type=CLASS. No DB-enforced FK because the soft ref pattern follows ADR-001/020 for tenant tables that may target deactivated classes through their lifetime.';

CREATE TABLE IF NOT EXISTS lib_reading_list_items (
  id                  UUID         PRIMARY KEY,
  reading_list_id     UUID         NOT NULL REFERENCES lib_reading_lists(id) ON DELETE CASCADE,
  catalogue_item_id   UUID         NOT NULL REFERENCES lib_catalogue_items(id),
  item_type           TEXT         NOT NULL DEFAULT 'RECOMMENDED',
  sort_order          INT          NOT NULL DEFAULT 0,
  added_by            UUID         NOT NULL REFERENCES hr_employees(id),
  notes               TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT lib_list_items_type_chk
    CHECK (item_type IN ('REQUIRED', 'RECOMMENDED', 'EXTENSION', 'REFERENCE')),
  CONSTRAINT lib_list_items_sort_chk
    CHECK (sort_order >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS lib_list_items_list_item_uq
  ON lib_reading_list_items (reading_list_id, catalogue_item_id);

CREATE INDEX IF NOT EXISTS lib_list_items_list_sort_idx
  ON lib_reading_list_items (reading_list_id, sort_order);

CREATE INDEX IF NOT EXISTS lib_list_items_item_idx
  ON lib_reading_list_items (catalogue_item_id);

COMMENT ON TABLE lib_reading_list_items IS
  'Items inside a reading list. UNIQUE(reading_list_id, catalogue_item_id) so an item appears at most once per list. CASCADE on reading_list_id because list items are meaningless without their list. NO ACTION on catalogue_item_id refuses item delete while reading lists reference it — same pattern as lib_reading_logs and lib_reviews. item_type drives the per-row pill in the Step 9 student UI.';

COMMENT ON COLUMN lib_reading_list_items.item_type IS
  'REQUIRED for items the teacher mandates. RECOMMENDED for general endorsements. EXTENSION for supplementary or advanced material. REFERENCE for items consulted but not read cover-to-cover.';

CREATE TABLE IF NOT EXISTS lib_reviews (
  id              UUID         PRIMARY KEY,
  item_id         UUID         NOT NULL REFERENCES lib_catalogue_items(id),
  student_id      UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  rating          INT          NOT NULL,
  review_text     TEXT,
  is_approved     BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT lib_reviews_rating_chk
    CHECK (rating BETWEEN 1 AND 5)
);

CREATE UNIQUE INDEX IF NOT EXISTS lib_reviews_item_student_uq
  ON lib_reviews (item_id, student_id);

CREATE INDEX IF NOT EXISTS lib_reviews_item_approved_idx
  ON lib_reviews (item_id, is_approved);

COMMENT ON TABLE lib_reviews IS
  'Student book reviews. UNIQUE(item_id, student_id) means each student gets one review per item — PATCH rather than re-POST for edits. The Step 7 ReviewService is the canonical writer. CASCADE on student_id because reviews are personal student data. NO ACTION on item_id refuses item delete while reviews reference it. is_approved=false is the librarian soft-hide path for inappropriate reviews — preserves the row for audit while the public catalogue listing filters by is_approved=true.';

COMMENT ON COLUMN lib_reviews.rating IS
  'INT 1..5 CHECK required. The student-facing UI surfaces 5 stars and writes the integer here. No nullability since a review without a rating is incomplete data.';
