/* 165_lib_recommendations_ill_import.sql
 * Phase 2 Cycle 25 Step 2 — M24 Library Advanced AI-ready
 * recommendations, interlibrary loans, and bulk catalogue import.
 *
 * Three new tenant base tables completing the P2-25 schema phase at
 * 6 lib_* tables across migrations 164 + 165 (the 3-table count
 * counts the new lib_class_set_checkouts + the 3 here — the plan-text
 * Step 1 lib_reading_lists + lib_reading_list_items pre-exist from
 * Cycle 12 migration 045 and only get additive ALTERs in 164).
 *
 *   lib_recommendations            — Per-student book recommendation
 *                                    with 5-value reason_type CHECK
 *                                    COLLABORATIVE_FILTERING,
 *                                    READING_LEVEL_MATCH,
 *                                    SUBJECT_MATCH, NEW_ARRIVAL,
 *                                    STAFF_PICK. Regenerated weekly
 *                                    by the Step 5
 *                                    LibraryRecommendationWorker as a
 *                                    FULL REPLACE per student — not
 *                                    UPSERT — so dismissed picks fall
 *                                    out of the next run cleanly. The
 *                                    worker DELETEs all rows for the
 *                                    student then INSERTs the top 20
 *                                    by composite score. score is a
 *                                    NUMERIC(5,3) normalised 0.000 to
 *                                    1.000 within each reason_type
 *                                    then weighted per the school
 *                                    config (Step 8 — out of P2-25a
 *                                    scope but the schema is forward
 *                                    compatible).
 *
 *                                    student_id CASCADE because
 *                                    recommendations are per-student
 *                                    operational data. recommended
 *                                    item_id NO ACTION refuses
 *                                    hard-delete of a catalogue item
 *                                    while recommendations reference
 *                                    it — same pattern as lib
 *                                    reading_logs and lib_reviews.
 *
 *                                    dismissed_at is the soft-hide
 *                                    column the Step 5 dismiss
 *                                    endpoint stamps. Dismissed rows
 *                                    are retained until the next
 *                                    weekly worker run wipes the
 *                                    student's recommendations. The
 *                                    Step 5 worker walks dismissed
 *                                    item ids before producing the
 *                                    next batch and excludes any item
 *                                    a student has dismissed in the
 *                                    last 90 days from re-recommend.
 *
 *                                    A partial UNIQUE INDEX
 *                                    (student_id, recommended_item_id)
 *                                    WHERE dismissed_at IS NULL caps
 *                                    active recommendations at one
 *                                    per (student, item) so the
 *                                    worker's INSERT cannot land
 *                                    duplicates if a race fires during
 *                                    the DELETE + INSERT window.
 *
 *   lib_interlibrary_loans         — Cross-institution loan tracking.
 *                                    loan_direction is a 2-value
 *                                    CHECK BORROWED, LENT. status is
 *                                    a 6-value CHECK REQUESTED,
 *                                    IN_TRANSIT, ACTIVE, RETURNED,
 *                                    OVERDUE, LOST. catalogue_item_id
 *                                    is nullable because BORROWED
 *                                    loans cover titles not yet in
 *                                    our catalogue (the librarian
 *                                    keys the title + ISBN as
 *                                    free-form text). LENT loans
 *                                    require the catalogue_item_id to
 *                                    be populated — the schema
 *                                    enforces this via the multi
 *                                    column direction_chk that pins
 *                                    LENT to NOT NULL on
 *                                    catalogue_item_id.
 *
 *                                    The state machine drives the
 *                                    dates: request_date NOT NULL
 *                                    always. received_date populated
 *                                    on REQUESTED → IN_TRANSIT (or
 *                                    REQUESTED → ACTIVE for direct
 *                                    LENT shipments). due_date
 *                                    populated on the ACTIVE
 *                                    transition. returned_date
 *                                    populated on the RETURNED
 *                                    transition. The schema does not
 *                                    enforce these in lockstep — the
 *                                    Step 5 service is the gate
 *                                    because the data shape can vary
 *                                    by partner institution
 *                                    (e.g. some partners ship
 *                                    same-day, some have IN_TRANSIT
 *                                    windows).
 *
 *                                    sent_date is the LENT-direction
 *                                    counterpart to received_date —
 *                                    when our library ships the book
 *                                    out. partner_institution is
 *                                    free-form TEXT NOT NULL.
 *
 *   lib_catalogue_import_jobs      — Async bulk catalogue import
 *                                    record. import_type is a 4-value
 *                                    CHECK ISBN_BATCH, MARC_IMPORT,
 *                                    CSV_UPLOAD, WORLDCAT_SYNC.
 *                                    status is a 5-value CHECK
 *                                    QUEUED, PARSING, IMPORTING,
 *                                    COMPLETED, FAILED. The Step 5
 *                                    CatalogueImportService is the
 *                                    canonical writer and the Step 5
 *                                    CatalogueImportWorker is the
 *                                    canonical updater for the
 *                                    counter columns (records
 *                                    imported, records_skipped,
 *                                    records_failed) and the
 *                                    completed_at stamp on terminal
 *                                    states.
 *
 *                                    ISBN dedup is the contract — the
 *                                    worker counts a duplicate ISBN
 *                                    as records_skipped, not
 *                                    records_failed, so a librarian
 *                                    importing an overlapping
 *                                    catalogue can see exactly how
 *                                    many net-new rows landed. The
 *                                    Step 5 worker writes the
 *                                    error_log_s3_key only when at
 *                                    least one row failed.
 *
 *                                    initiated_by NO ACTION because
 *                                    the import audit row outlives
 *                                    the librarian leaving (matches
 *                                    Cycle 12 lib_reading_lists
 *                                    .created_by NO ACTION).
 *
 *                                    source_file_s3_key is the
 *                                    uploaded file. NULL for the
 *                                    WORLDCAT_SYNC and ISBN_BATCH
 *                                    paths that take inline JSON
 *                                    rather than an uploaded file.
 *
 * Soft cross-schema refs per ADR-001 / ADR-020:
 *   lib_interlibrary_loans.school_id      -> platform.schools(id)
 *   lib_catalogue_import_jobs.school_id   -> platform.schools(id)
 *
 * DB-enforced intra-tenant FKs (5 logical):
 *   lib_recommendations.student_id           -> sis_students(id) CASCADE
 *   lib_recommendations.recommended_item_id  -> lib_catalogue_items(id) NO ACTION
 *   lib_recommendations.dismissed_by         -> hr_employees(id) SET NULL (nullable)
 *   lib_interlibrary_loans.catalogue_item_id -> lib_catalogue_items(id) NO ACTION (nullable)
 *   lib_catalogue_import_jobs.initiated_by   -> hr_employees(id) NO ACTION
 *
 * 0 cross-schema FKs.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header, no semicolons inside any string literal or
 * comment per the splitter trap from Cycles 4 onwards.
 */

CREATE TABLE IF NOT EXISTS lib_recommendations (
  id                      UUID         PRIMARY KEY,
  student_id              UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  recommended_item_id     UUID         NOT NULL REFERENCES lib_catalogue_items(id),
  reason_type             TEXT         NOT NULL,
  score                   NUMERIC(5,3),
  reason_metadata         JSONB,
  dismissed_at            TIMESTAMPTZ,
  dismissed_by            UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  generated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT lib_recs_reason_chk
    CHECK (reason_type IN (
      'COLLABORATIVE_FILTERING',
      'READING_LEVEL_MATCH',
      'SUBJECT_MATCH',
      'NEW_ARRIVAL',
      'STAFF_PICK'
    )),
  CONSTRAINT lib_recs_score_chk
    CHECK (score IS NULL OR (score >= 0 AND score <= 1))
);

CREATE INDEX IF NOT EXISTS lib_recs_student_score_idx
  ON lib_recommendations (student_id, score DESC);

CREATE INDEX IF NOT EXISTS lib_recs_student_generated_idx
  ON lib_recommendations (student_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS lib_recs_item_idx
  ON lib_recommendations (recommended_item_id);

CREATE UNIQUE INDEX IF NOT EXISTS lib_recs_student_item_active_uq
  ON lib_recommendations (student_id, recommended_item_id)
  WHERE dismissed_at IS NULL;

COMMENT ON TABLE lib_recommendations IS
  'Phase 2 Cycle 25 — Per-student book recommendation. The Step 5 LibraryRecommendationWorker regenerates recommendations weekly as a FULL REPLACE per student. DELETE all rows for the student then INSERT the top 20 by composite score. Dismissed picks fall out of the next run via dismissed_at. CASCADE on student_id because recommendations are per-student operational data. NO ACTION on recommended_item_id refuses hard-delete of a catalogue item while recommendations reference it — same audit-preservation pattern as lib_reading_logs and lib_reviews. Partial UNIQUE(student_id, recommended_item_id) WHERE dismissed_at IS NULL caps active recommendations at one per (student, item).';

COMMENT ON COLUMN lib_recommendations.reason_type IS
  'COLLABORATIVE_FILTERING — students who read X also read Y. READING_LEVEL_MATCH — Lexile or AR level alignment with the student. SUBJECT_MATCH — catalogue subject tag overlap with the students checkout history. NEW_ARRIVAL — recently catalogued in the students interest areas. STAFF_PICK — librarian-flagged from lib_reading_lists.list_type=GENERAL.';

COMMENT ON COLUMN lib_recommendations.score IS
  'NUMERIC(5,3) normalised 0.000 to 1.000 within each reason_type then weighted per the school config from Step 8 (out of P2-25a scope — the schema is forward compatible). NULL means the worker did not score this row — STAFF_PICK rows often skip scoring because the librarian curation is the signal.';

COMMENT ON COLUMN lib_recommendations.reason_metadata IS
  'Optional JSONB context for the recommendation. Examples — COLLABORATIVE_FILTERING populates {sharedCheckoutCount: 5, similarStudentCount: 3}. READING_LEVEL_MATCH populates {studentLexile: 800, itemLexile: 780}. The Step 6 student UI surfaces a one-line because-X explanation per card from this column.';

COMMENT ON COLUMN lib_recommendations.dismissed_at IS
  'Stamped by the Step 5 dismiss endpoint. The Step 5 worker walks dismissed item ids before producing the next batch and excludes any item a student has dismissed in the last 90 days from re-recommend.';

CREATE TABLE IF NOT EXISTS lib_interlibrary_loans (
  id                      UUID         PRIMARY KEY,
  school_id               UUID         NOT NULL,
  loan_direction          TEXT         NOT NULL,
  partner_institution     TEXT         NOT NULL,
  catalogue_item_id       UUID         REFERENCES lib_catalogue_items(id),
  title                   TEXT         NOT NULL,
  author                  TEXT,
  isbn                    TEXT,
  request_date            DATE         NOT NULL,
  received_date           DATE,
  sent_date               DATE,
  due_date                DATE,
  returned_date           DATE,
  status                  TEXT         NOT NULL DEFAULT 'REQUESTED',
  notes                   TEXT,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT lib_ill_direction_chk
    CHECK (loan_direction IN ('BORROWED', 'LENT')),
  CONSTRAINT lib_ill_status_chk
    CHECK (status IN (
      'REQUESTED',
      'IN_TRANSIT',
      'ACTIVE',
      'RETURNED',
      'OVERDUE',
      'LOST'
    )),
  CONSTRAINT lib_ill_lent_catalogue_chk
    CHECK (
      loan_direction = 'BORROWED'
      OR (loan_direction = 'LENT' AND catalogue_item_id IS NOT NULL)
    ),
  CONSTRAINT lib_ill_dates_chk
    CHECK (
      (due_date IS NULL OR due_date >= request_date)
      AND (returned_date IS NULL OR returned_date >= request_date)
    )
);

CREATE INDEX IF NOT EXISTS lib_ill_school_status_idx
  ON lib_interlibrary_loans (school_id, status);

CREATE INDEX IF NOT EXISTS lib_ill_school_direction_idx
  ON lib_interlibrary_loans (school_id, loan_direction, status);

CREATE INDEX IF NOT EXISTS lib_ill_overdue_idx
  ON lib_interlibrary_loans (due_date)
  WHERE status IN ('ACTIVE', 'OVERDUE') AND returned_date IS NULL;

COMMENT ON TABLE lib_interlibrary_loans IS
  'Phase 2 Cycle 25 — Cross-institution loan tracking. loan_direction is BORROWED when our library is the receiver, LENT when our library ships out. The Step 5 InterlibraryLoanService is the canonical writer. BORROWED rows may have a NULL catalogue_item_id because the title is not in our catalogue. LENT rows require catalogue_item_id NOT NULL via the multi-column direction_chk. Status walks REQUESTED → IN_TRANSIT → ACTIVE → RETURNED with ACTIVE past due_date flipping to OVERDUE by the Step 5 overdue sweep.';

COMMENT ON COLUMN lib_interlibrary_loans.catalogue_item_id IS
  'Soft FK to lib_catalogue_items(id) ON DELETE NO ACTION via the table-level REFERENCES — preserves the ILL audit even if a librarian retires the catalogue row. NULL for BORROWED requests covering titles not in our catalogue.';

CREATE TABLE IF NOT EXISTS lib_catalogue_import_jobs (
  id                      UUID         PRIMARY KEY,
  school_id               UUID         NOT NULL,
  import_type             TEXT         NOT NULL,
  source_file_s3_key      TEXT,
  total_records           INT,
  records_imported        INT          NOT NULL DEFAULT 0,
  records_skipped         INT          NOT NULL DEFAULT 0,
  records_failed          INT          NOT NULL DEFAULT 0,
  status                  TEXT         NOT NULL DEFAULT 'QUEUED',
  initiated_by            UUID         NOT NULL REFERENCES hr_employees(id),
  error_log_s3_key        TEXT,
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT lib_import_type_chk
    CHECK (import_type IN (
      'ISBN_BATCH',
      'MARC_IMPORT',
      'CSV_UPLOAD',
      'WORLDCAT_SYNC'
    )),
  CONSTRAINT lib_import_status_chk
    CHECK (status IN ('QUEUED', 'PARSING', 'IMPORTING', 'COMPLETED', 'FAILED')),
  CONSTRAINT lib_import_counters_chk
    CHECK (
      records_imported >= 0
      AND records_skipped >= 0
      AND records_failed >= 0
    )
);

CREATE INDEX IF NOT EXISTS lib_import_school_status_idx
  ON lib_catalogue_import_jobs (school_id, status);

CREATE INDEX IF NOT EXISTS lib_import_school_created_idx
  ON lib_catalogue_import_jobs (school_id, created_at DESC);

COMMENT ON TABLE lib_catalogue_import_jobs IS
  'Phase 2 Cycle 25 — Async bulk catalogue import record. The Step 5 CatalogueImportService creates the QUEUED row and the Step 5 CatalogueImportWorker processes it. ISBN dedup is the contract — the worker counts duplicate ISBNs as records_skipped, not records_failed, so a librarian importing an overlapping catalogue can see how many net-new rows landed. The worker writes error_log_s3_key only when records_failed > 0. Emits lib.import.completed on the terminal COMPLETED or FAILED transition via the platform outbox for the future Step 6 librarian-notification consumer.';

COMMENT ON COLUMN lib_catalogue_import_jobs.import_type IS
  'ISBN_BATCH — librarian pastes a list of ISBNs. The worker looks each up against the existing catalogue and creates new lib_catalogue_items + lib_catalogue_copies rows for unseen ISBNs. MARC_IMPORT — uploaded .mrc file (deferred to a future P3 cycle that adds a MARC parser — the schema is forward compatible). CSV_UPLOAD — uploaded CSV with title/author/isbn/etc columns. WORLDCAT_SYNC — placeholder for future OCLC WorldCat API integration (deferred per plan).';

COMMENT ON COLUMN lib_catalogue_import_jobs.records_skipped IS
  'Count of records skipped because the ISBN already exists in this schools lib_catalogue_items. The Step 5 worker increments this counter on every dedup hit so a librarian sees the net-new vs already-present split.';
