/* 038_svc_coordinated_care_mandatory.sql
 * Cycle 11 Step 3 — Coordinated care notes plus mandatory reporting
 * plus the Cycle 9 BIP caseload_id FK backfill.
 *
 * Two new tenant base tables plus one ALTER on the existing
 * svc_behavior_plans table to convert the Cycle 9 forward-compatible
 * soft caseload_id ref into a real DB-enforced FK to svc_caseloads.
 *
 *   svc_coordinated_care_notes  Shared observation thread between the
 *                               nurse and counsellor teams. author
 *                               role is a 2-value enum CHECK NURSE
 *                               COUNSELLOR. The Step 7
 *                               CoordinatedCareService gates every
 *                               read on the intersection of
 *                               hlt-001:read AND cou-007:read so an
 *                               actor missing either permission gets
 *                               403. Teachers and parents always
 *                               403. author_person_id is a soft ref
 *                               to platform.iam_person per ADR-001.
 *   svc_mandatory_reports       CPS-filing log. report_type is a
 *                               4-value enum CHECK SUSPECTED_ABUSE
 *                               SUSPECTED_NEGLECT IMMINENT_DANGER
 *                               OTHER. status is a 4-value enum
 *                               CHECK FILED CPS_CONTACTED
 *                               INVESTIGATION_ACTIVE CLOSED. The
 *                               core fields description report_type
 *                               reported_to_authority and report_date
 *                               are IMMUTABLE once past FILED.
 *                               Service-side discipline. The Step 7
 *                               MandatoryReportService refuses any
 *                               PATCH that touches those fields with
 *                               400 Mandatory report core fields are
 *                               immutable once filed. Only
 *                               cps_response and status can be
 *                               updated as the case evolves.
 *                               NO ACTION on student delete enforces
 *                               retention. Reports are kept
 *                               permanently per the M27 ERD.
 *
 *   FK backfill on svc_behavior_plans  Adds a real DB-enforced FK
 *                                      from svc_behavior_plans
 *                                      caseload_id to svc_caseloads
 *                                      id with ON DELETE SET NULL.
 *                                      Cycle 9 shipped this column
 *                                      as a forward-compatible soft
 *                                      ref because svc_caseloads did
 *                                      not exist yet. Cycle 11 Step
 *                                      1 introduced svc_caseloads.
 *                                      Cycle 11 Step 3 tightens the
 *                                      ref into a real FK now that
 *                                      the target exists. Uses the
 *                                      DROP CONSTRAINT IF EXISTS
 *                                      followed by ADD CONSTRAINT
 *                                      pattern from CLAUDE.md so the
 *                                      migration is idempotent and
 *                                      splitter-safe. ON DELETE SET
 *                                      NULL preserves the BIP when a
 *                                      caseload is hard-deleted. The
 *                                      Step 4 seed will also
 *                                      backfill Maya BIP caseload_id
 *                                      to point at the seeded
 *                                      svc_caseloads row Hayes
 *                                      assigned to Maya.
 *
 * Soft cross-schema refs per ADR-001 and ADR-020:
 *   svc_coordinated_care_notes.author_person_id    -> platform.iam_person(id) soft
 *   svc_mandatory_reports.reporter_person_id       -> platform.iam_person(id) soft
 *
 * DB-enforced intra-tenant FKs (3 logical):
 *   svc_coordinated_care_notes.student_id    -> sis_students(id) CASCADE
 *     Consistent with the student-referencing table convention.
 *     When a student is removed from the system the coordinated
 *     care thread goes with them.
 *   svc_mandatory_reports.student_id         -> sis_students(id) NO ACTION
 *     Enforces retention. Mandatory reports outlive normal record
 *     cleanup. Refuses delete of a student with mandatory reports
 *     and forces admin to archive the audit trail first. Mirrors
 *     hlth_health_access_log from Cycle 10.
 *   svc_behavior_plans.caseload_id           -> svc_caseloads(id) SET NULL
 *     The Cycle 9 forward-compatible soft ref tightened into a real
 *     FK now that svc_caseloads exists. SET NULL preserves the BIP
 *     when its caseload is closed and cleaned up.
 *
 * 0 cross-schema FKs.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * DROP CONSTRAINT IF EXISTS followed by ADD CONSTRAINT for the FK
 * backfill since Postgres has no ADD CONSTRAINT IF NOT EXISTS. Block
 * comment header. No semicolons inside any string literal or
 * comment per the splitter trap from Cycles 4 through 11. The
 * splitter cuts on every semicolon regardless of quoting context
 * including inside block comments and inside default expressions.
 */

CREATE TABLE IF NOT EXISTS svc_coordinated_care_notes (
  id                  UUID         PRIMARY KEY,
  student_id          UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  author_person_id    UUID         NOT NULL,
  author_role         TEXT         NOT NULL,
  note_text           TEXT         NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_coordinated_care_notes_role_chk
    CHECK (author_role IN ('NURSE', 'COUNSELLOR'))
);

CREATE INDEX IF NOT EXISTS svc_coordinated_care_notes_student_time_idx
  ON svc_coordinated_care_notes (student_id, created_at DESC);

COMMENT ON TABLE svc_coordinated_care_notes IS
  'Shared observation thread between the nurse and counsellor teams. The Step 7 CoordinatedCareService gates every read on the intersection of hlt-001:read AND cou-007:read so an actor missing either permission gets 403. Teachers and parents always 403. The 2-value author_role CHECK NURSE COUNSELLOR pins the author scope and the Step 7 service validates that the calling actor role matches before insert.';

COMMENT ON COLUMN svc_coordinated_care_notes.author_person_id IS
  'Soft to platform.iam_person(id) per ADR-001. Captures the author person id stamped from actor.personId. The Step 7 service-layer write path never trusts caller input for this column.';

COMMENT ON COLUMN svc_coordinated_care_notes.author_role IS
  'NURSE or COUNSELLOR. The Step 7 service validates that the value matches the actor role at the application layer before insert. Pins the row to the nurse and counsellor surfaces only.';

CREATE TABLE IF NOT EXISTS svc_mandatory_reports (
  id                       UUID         PRIMARY KEY,
  student_id               UUID         NOT NULL REFERENCES sis_students(id),
  reporter_person_id       UUID         NOT NULL,
  report_type              TEXT         NOT NULL,
  reported_to_authority    TEXT         NOT NULL,
  report_date              TIMESTAMPTZ  NOT NULL,
  description              TEXT         NOT NULL,
  supporting_docs_s3_keys  TEXT[],
  cps_response             TEXT,
  status                   TEXT         NOT NULL DEFAULT 'FILED',
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_mandatory_reports_type_chk
    CHECK (report_type IN ('SUSPECTED_ABUSE', 'SUSPECTED_NEGLECT', 'IMMINENT_DANGER', 'OTHER')),
  CONSTRAINT svc_mandatory_reports_status_chk
    CHECK (status IN ('FILED', 'CPS_CONTACTED', 'INVESTIGATION_ACTIVE', 'CLOSED'))
);

CREATE INDEX IF NOT EXISTS svc_mandatory_reports_student_date_idx
  ON svc_mandatory_reports (student_id, report_date DESC);

CREATE INDEX IF NOT EXISTS svc_mandatory_reports_status_idx
  ON svc_mandatory_reports (status);

COMMENT ON TABLE svc_mandatory_reports IS
  'CPS-filing log. The Step 7 MandatoryReportService is the canonical writer. status starts at FILED and progresses through CPS_CONTACTED INVESTIGATION_ACTIVE CLOSED. The core fields description report_type reported_to_authority and report_date are IMMUTABLE once past FILED. Service-side discipline. The Step 7 PATCH endpoint refuses any change to those fields with 400 Mandatory report core fields are immutable once filed. Only cps_response and status can be updated as the case evolves. The student_id FK is NO ACTION so a student deletion attempt with mandatory reports fails loudly and forces the admin to archive the audit trail first. Reports are retained permanently per the M27 ERD.';

COMMENT ON COLUMN svc_mandatory_reports.reporter_person_id IS
  'Soft to platform.iam_person(id) per ADR-001. Captures the reporter person id stamped from actor.personId. The Step 7 service-layer write path never trusts caller input for this column.';

COMMENT ON COLUMN svc_mandatory_reports.report_type IS
  'SUSPECTED_ABUSE for physical or sexual abuse signs. SUSPECTED_NEGLECT for failure to provide care. IMMINENT_DANGER for crisis-level threat to safety. OTHER for anything else covered by the schools mandatory reporting policy. Once FILED this column is immutable.';

COMMENT ON COLUMN svc_mandatory_reports.status IS
  'FILED on initial submission. CPS_CONTACTED when CPS or the relevant authority has been notified. INVESTIGATION_ACTIVE when the authority is investigating. CLOSED when the case is resolved. Only this column and cps_response are mutable after FILED.';

COMMENT ON CONSTRAINT svc_mandatory_reports_type_chk ON svc_mandatory_reports IS
  'Pins report_type to one of the 4 valid kinds. Once FILED this column is immutable per service-side discipline in the Step 7 MandatoryReportService.';

ALTER TABLE svc_behavior_plans
  DROP CONSTRAINT IF EXISTS svc_behavior_plans_caseload_id_fkey;

ALTER TABLE svc_behavior_plans
  ADD CONSTRAINT svc_behavior_plans_caseload_id_fkey
  FOREIGN KEY (caseload_id) REFERENCES svc_caseloads(id) ON DELETE SET NULL;

COMMENT ON COLUMN svc_behavior_plans.caseload_id IS
  'DB-enforced FK to svc_caseloads(id) per the Cycle 11 Step 3 backfill. Nullable so a BIP can exist without a caseload (the Cycle 9 demo seed shipped without a caseload assignment). ON DELETE SET NULL preserves the BIP when its caseload is closed and cleaned up. The Step 4 seed will populate Mayas BIP caseload_id to point at the seeded svc_caseloads row Hayes assigned to Maya.';
