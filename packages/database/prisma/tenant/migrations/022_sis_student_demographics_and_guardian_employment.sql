/* 022_sis_student_demographics_and_guardian_employment.sql
 * Profile and Household Mini-Cycle Step 2.
 *
 * One new tenant base table: sis_student_demographics. Carries the per-student
 * demographic + light medical-alert fields that the profile UI surfaces on the
 * Demographics tab for STUDENT personas. Distinct from the future M30 Health
 * tables which hold the full health record. UNIQUE(student_id) so each student
 * has at most one demographics row.
 *
 * Four new columns on the existing sis_guardians table for the Employment tab
 * surfaced to GUARDIAN personas: employer, employer_phone, occupation,
 * work_address. All nullable. The existing relationship column already covers
 * the relationship-to-student field referenced in the original spec, so it is
 * not re-added here.
 *
 * No CHECK constraints on the new columns this round. Demographics values are
 * free-form per the schema. A school may use any of Female, Male, Non-binary,
 * or a school-specific value. The UI offers a curated list of suggestions but
 * the column accepts any TEXT. medical_alert_notes is a brief flag intended
 * to surface in roll-call and substitute views, not a full health record.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS and ADD COLUMN IF NOT
 * EXISTS for idempotency. Block-comment header uses no semicolons anywhere,
 * since the provision splitter cuts on every semicolon regardless of quoting
 * context including inside block comments. This trap was caught in Cycles 4
 * through 6 and again in this Step 2 first attempt.
 */

CREATE TABLE IF NOT EXISTS sis_student_demographics (
  id                   UUID         PRIMARY KEY,
  student_id           UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  gender               TEXT,
  ethnicity            TEXT,
  primary_language     TEXT,
  birth_country        TEXT,
  citizenship          TEXT,
  medical_alert_notes  TEXT,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sis_student_demographics_student_id_uq
  ON sis_student_demographics (student_id);

COMMENT ON TABLE sis_student_demographics IS
  'Per-student demographic and brief medical-alert fields surfaced on the Profile UI Demographics tab for STUDENT personas. Distinct from M30 Health which holds the full health record.';

COMMENT ON COLUMN sis_student_demographics.medical_alert_notes IS
  'Brief flag intended for roll-call and substitute-teacher views, not a full health record. Example "EpiPen in nurse office".';

ALTER TABLE sis_guardians
  ADD COLUMN IF NOT EXISTS employer       TEXT,
  ADD COLUMN IF NOT EXISTS employer_phone TEXT,
  ADD COLUMN IF NOT EXISTS occupation     TEXT,
  ADD COLUMN IF NOT EXISTS work_address   TEXT;

COMMENT ON COLUMN sis_guardians.employer IS
  'Free-form employer name surfaced on the Profile UI Employment tab for GUARDIAN personas.';

COMMENT ON COLUMN sis_guardians.occupation IS
  'Free-form occupation title surfaced alongside employer on the Profile UI Employment tab.';
