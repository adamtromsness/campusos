/* 032_hlth_health_records.sql
 * Cycle 10 Step 1 — M23 Health Records core schema.
 *
 * Cycle 10 ships the most access-restricted module in the system. The
 * hlth_* tables are flagged for a separate HIPAA-compliant KMS key in
 * the ERD. For the dev / demo phase the tables ship without
 * field-level encryption but the access control layer is strict from
 * day one. A dedicated health_record:read permission gates every read
 * endpoint. An immutable hlth_health_access_log records every access
 * for HIPAA audit. Teachers never query hlth_* tables directly. They
 * read the existing sis_student_active_accommodations read model
 * populated by the Step 7 IepAccommodationConsumer per ADR-030.
 *
 * Four new tenant base tables. Steps 2 and 3 add 11 more for
 * 15 hlth_* tables total in Cycle 10.
 *
 *   hlth_student_health_records   One record per student. UNIQUE on
 *                                 student_id. blood_type and physician
 *                                 contact info are nullable. allergies
 *                                 is a structured JSONB array of
 *                                 allergen and severity rows. The
 *                                 master row that conditions and
 *                                 immunisations and medications all
 *                                 link to. Step 5 HealthRecordService
 *                                 is the canonical writer.
 *
 *   hlth_medical_conditions       Per-record condition. severity is a
 *                                 3-value enum CHECK MILD / MODERATE /
 *                                 SEVERE. is_active flags soft
 *                                 deactivation when a condition
 *                                 resolves so the historical row stays
 *                                 in the audit timeline. INDEX on
 *                                 (health_record_id, is_active) for
 *                                 the active-conditions hot path.
 *
 *   hlth_immunisations            Per-record vaccine row. status is a
 *                                 3-value enum CHECK CURRENT / OVERDUE
 *                                 / WAIVED. due_date drives the
 *                                 OVERDUE compliance dashboard the
 *                                 Step 5 HealthRecordService rolls up
 *                                 school wide. INDEX on
 *                                 (health_record_id, vaccine_name).
 *
 *   hlth_health_access_log        IMMUTABLE per ADR-010. No UPDATE.
 *                                 No DELETE. access_type is a 9-value
 *                                 enum CHECK covering every health
 *                                 read shape (VIEW_RECORD,
 *                                 VIEW_CONDITIONS, VIEW_IMMUNISATIONS,
 *                                 VIEW_MEDICATIONS, VIEW_VISITS,
 *                                 VIEW_IEP, VIEW_SCREENING,
 *                                 VIEW_DIETARY, EXPORT). Every Step 5
 *                                 to 7 health read endpoint writes a
 *                                 row before returning data. INDEX on
 *                                 (student_id, accessed_at DESC) for
 *                                 the per-student audit query and
 *                                 INDEX on (accessed_by, accessed_at
 *                                 DESC) for the per-actor audit query.
 *
 * Soft cross-schema refs per ADR-001 and ADR-020:
 *   hlth_student_health_records.school_id    -> platform.schools(id)
 *   hlth_health_access_log.school_id         -> platform.schools(id)
 *   hlth_health_access_log.accessed_by       -> platform.platform_users(id) soft
 *
 * DB-enforced intra-tenant FKs (4 logical):
 *   hlth_student_health_records.student_id     -> sis_students(id) CASCADE
 *     When a student is removed from the system the health record
 *     goes with them. The conservative privacy choice consistent with
 *     Cycle 9 sis_discipline_incidents.student_id.
 *   hlth_medical_conditions.health_record_id   -> hlth_student_health_records(id) CASCADE
 *     A condition has no meaning without its parent health record.
 *   hlth_immunisations.health_record_id        -> hlth_student_health_records(id) CASCADE
 *     An immunisation has no meaning without its parent health record.
 *   hlth_health_access_log.student_id          -> sis_students(id) NO ACTION
 *     Refuses delete of a student who has audit log entries. Forces
 *     admin to retain or archive the audit trail before student
 *     removal. The audit log outlives normal record cleanup.
 *
 * 0 cross-schema FKs.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header, no semicolons inside any string literal or
 * comment per the splitter trap from Cycles 4 through 9. The splitter
 * cuts on every semicolon regardless of quoting context including
 * inside block comments and inside default expressions.
 */

CREATE TABLE IF NOT EXISTS hlth_student_health_records (
  id                          UUID         PRIMARY KEY,
  school_id                   UUID         NOT NULL,
  student_id                  UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  blood_type                  TEXT,
  allergies                   JSONB        NOT NULL DEFAULT '[]'::jsonb,
  emergency_medical_notes     TEXT,
  physician_name              TEXT,
  physician_phone             TEXT,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS hlth_student_health_records_student_uq
  ON hlth_student_health_records (student_id);

CREATE INDEX IF NOT EXISTS hlth_student_health_records_school_idx
  ON hlth_student_health_records (school_id);

COMMENT ON TABLE hlth_student_health_records IS
  'One health record per student. UNIQUE on student_id so the Step 5 HealthRecordService can upsert without a manual lookup. The Step 5 service is the canonical writer. Reads always go through the service so the hlth_health_access_log row is recorded before the response body leaves the server.';

COMMENT ON COLUMN hlth_student_health_records.allergies IS
  'Structured JSONB array. Each entry is an object with allergen, severity, reaction, notes. The Step 9 dietary integration reads severity SEVERE entries to drive the POS allergen alert toggle. Severity values match the hlth_medical_conditions severity enum.';

COMMENT ON COLUMN hlth_student_health_records.emergency_medical_notes IS
  'Free-form notes that appear on the emergency contact card. Surfaced to first responders and to substitutes through the Cycle 5 substitution timetable when a student needs special handling on a covered day.';

CREATE TABLE IF NOT EXISTS hlth_medical_conditions (
  id                  UUID         PRIMARY KEY,
  health_record_id    UUID         NOT NULL REFERENCES hlth_student_health_records(id) ON DELETE CASCADE,
  condition_name      TEXT         NOT NULL,
  diagnosis_date      DATE,
  is_active           BOOLEAN      NOT NULL DEFAULT true,
  severity            TEXT         NOT NULL,
  management_plan     TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT hlth_medical_conditions_severity_chk
    CHECK (severity IN ('MILD', 'MODERATE', 'SEVERE'))
);

CREATE INDEX IF NOT EXISTS hlth_medical_conditions_record_active_idx
  ON hlth_medical_conditions (health_record_id, is_active);

COMMENT ON TABLE hlth_medical_conditions IS
  'Per-record medical condition. is_active flags soft deactivation so a resolved condition stays in the historical timeline. The Step 5 ConditionService writes is_active = false rather than DELETE so the audit trail is preserved.';

COMMENT ON COLUMN hlth_medical_conditions.management_plan IS
  'Internal staff-side text. Stripped from the parent health summary by the Step 5 service rowToDto when the caller is a guardian. Parents see condition_name and severity only. Never visible to teachers.';

CREATE TABLE IF NOT EXISTS hlth_immunisations (
  id                  UUID         PRIMARY KEY,
  health_record_id    UUID         NOT NULL REFERENCES hlth_student_health_records(id) ON DELETE CASCADE,
  vaccine_name        TEXT         NOT NULL,
  administered_date   DATE,
  due_date            DATE,
  administered_by     TEXT,
  status              TEXT         NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT hlth_immunisations_status_chk
    CHECK (status IN ('CURRENT', 'OVERDUE', 'WAIVED'))
);

CREATE INDEX IF NOT EXISTS hlth_immunisations_record_vaccine_idx
  ON hlth_immunisations (health_record_id, vaccine_name);

CREATE INDEX IF NOT EXISTS hlth_immunisations_record_status_idx
  ON hlth_immunisations (health_record_id, status);

COMMENT ON TABLE hlth_immunisations IS
  'Per-record immunisation row. The Step 5 HealthRecordService rolls up status counts across the school for the immunisation compliance dashboard. WAIVED rows count as compliant. OVERDUE rows drive the admin queue.';

COMMENT ON COLUMN hlth_immunisations.administered_by IS
  'Free-form text. Captures the external clinic or school nurse name. Not a soft FK to hr_employees because parent-supplied immunisation records often reference clinic names that have no employee record.';

CREATE TABLE IF NOT EXISTS hlth_health_access_log (
  id              UUID         PRIMARY KEY,
  school_id       UUID         NOT NULL,
  accessed_by     UUID         NOT NULL,
  student_id      UUID         NOT NULL REFERENCES sis_students(id),
  access_type     TEXT         NOT NULL,
  ip_address      TEXT,
  accessed_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT hlth_health_access_log_type_chk
    CHECK (access_type IN (
      'VIEW_RECORD',
      'VIEW_CONDITIONS',
      'VIEW_IMMUNISATIONS',
      'VIEW_MEDICATIONS',
      'VIEW_VISITS',
      'VIEW_IEP',
      'VIEW_SCREENING',
      'VIEW_DIETARY',
      'EXPORT'
    ))
);

CREATE INDEX IF NOT EXISTS hlth_health_access_log_student_time_idx
  ON hlth_health_access_log (student_id, accessed_at DESC);

CREATE INDEX IF NOT EXISTS hlth_health_access_log_actor_time_idx
  ON hlth_health_access_log (accessed_by, accessed_at DESC);

COMMENT ON TABLE hlth_health_access_log IS
  'IMMUTABLE per ADR-010. Service-side discipline. No UPDATE. No DELETE. Every health read endpoint writes a row here before returning data. The Step 5 HealthAccessLogService.recordAccess helper is the only writer. The 9-value access_type enum covers every health read shape so the per-student audit query can group by access_type. The student_id FK is NO ACTION so a student deletion attempt with audit entries fails loudly and forces the admin to archive the audit trail first.';

COMMENT ON COLUMN hlth_health_access_log.accessed_by IS
  'Soft ref to platform.platform_users.id per ADR-001. Captures the actor account id. The Step 5 service stamps this from actor.accountId resolved by ActorContextService.';

COMMENT ON COLUMN hlth_health_access_log.access_type IS
  'VIEW_RECORD covers the full record fetch. VIEW_CONDITIONS / VIEW_IMMUNISATIONS / VIEW_MEDICATIONS / VIEW_VISITS / VIEW_IEP / VIEW_SCREENING / VIEW_DIETARY are the per-domain reads. EXPORT is reserved for future bulk export endpoints. The 9-value list aligns with the M23 ERD entry for hlth_health_access_log.';
