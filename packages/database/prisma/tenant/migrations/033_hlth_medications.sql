/* 033_hlth_medications.sql
 * Cycle 10 Step 2 — M23 Health Medication schema.
 *
 * Three new tenant base tables for the medication management domain.
 * Per-medication daily schedule slots feed the nurse dashboard's
 * checklist. Administration rows log every dose with a multi-column
 * CHECK that pins missed doses to a NULL administered_at and
 * a NOT NULL missed_reason — the canonical missed-dose audit shape.
 *
 *   hlth_medications                Per-record medication. route is a
 *                                   5-value enum CHECK ORAL / TOPICAL
 *                                   / INHALER / INJECTION / OTHER.
 *                                   is_self_administered flags
 *                                   medications the student carries
 *                                   themselves (epinephrine pen,
 *                                   inhaler) so the nurse dashboard
 *                                   can sort them out of the daily
 *                                   admin checklist. is_active flags
 *                                   soft deactivation when a course
 *                                   completes so the historical row
 *                                   stays in the audit timeline.
 *
 *   hlth_medication_schedule        Per-medication daily schedule
 *                                   slot. scheduled_time is a TIME
 *                                   (no date — the slot recurs).
 *                                   day_of_week is nullable
 *                                   SMALLINT 0..6 with NULL meaning
 *                                   "every day" (matches the Cycle 5
 *                                   sch_periods convention). The Step
 *                                   6 ScheduleService uses this to
 *                                   render the daily checklist on the
 *                                   nurse dashboard.
 *
 *   hlth_medication_administrations Per-dose log. administered_at is
 *                                   nullable when was_missed is true
 *                                   (the CHECK enforces the lockstep).
 *                                   schedule_entry_id is nullable for
 *                                   PRN / unscheduled doses.
 *                                   missed_reason is a 5-value enum
 *                                   CHECK STUDENT_ABSENT /
 *                                   STUDENT_REFUSED /
 *                                   MEDICATION_UNAVAILABLE /
 *                                   PARENT_CANCELLED / OTHER. Multi-column
 *                                   missed_chk pins missed doses to
 *                                   administered_at NULL AND
 *                                   missed_reason NOT NULL. Active
 *                                   doses pin missed_reason NULL AND
 *                                   administered_at NOT NULL. Partial
 *                                   INDEX on (schedule_entry_id,
 *                                   was_missed) WHERE was_missed = true
 *                                   for the missed-dose audit query.
 *
 * DB-enforced intra-tenant FKs (4 logical):
 *   hlth_medications.health_record_id              -> hlth_student_health_records(id) CASCADE
 *     A medication has no meaning without its parent health record.
 *   hlth_medication_schedule.medication_id         -> hlth_medications(id) CASCADE
 *     A schedule slot has no meaning without its parent medication.
 *   hlth_medication_administrations.medication_id  -> hlth_medications(id) CASCADE
 *     An administration row has no meaning without its parent medication.
 *   hlth_medication_administrations.administered_by-> hr_employees(id) SET NULL
 *     Audit trail survives a nurse leaving the school. The row remains
 *     for compliance review with administered_by NULL.
 *
 * Soft cross-schema refs per ADR-001 and ADR-020: none new in this step.
 *
 * 0 cross-schema FKs.
 *
 * The schedule_entry_id soft ref intentionally has no DB-enforced FK
 * to hlth_medication_schedule. When a nurse retires a slot (the
 * patient's schedule changes) the historical administrations
 * remain pinned to the medication via medication_id. The nullable
 * column reflects PRN doses that never had a slot.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header, no semicolons inside any string literal or
 * comment per the splitter trap from Cycles 4 through 10.
 */

CREATE TABLE IF NOT EXISTS hlth_medications (
  id                          UUID         PRIMARY KEY,
  health_record_id            UUID         NOT NULL REFERENCES hlth_student_health_records(id) ON DELETE CASCADE,
  medication_name             TEXT         NOT NULL,
  dosage                      TEXT,
  frequency                   TEXT,
  route                       TEXT         NOT NULL,
  prescribing_physician       TEXT,
  is_self_administered        BOOLEAN      NOT NULL DEFAULT false,
  is_active                   BOOLEAN      NOT NULL DEFAULT true,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT hlth_medications_route_chk
    CHECK (route IN ('ORAL', 'TOPICAL', 'INHALER', 'INJECTION', 'OTHER'))
);

CREATE INDEX IF NOT EXISTS hlth_medications_record_active_idx
  ON hlth_medications (health_record_id, is_active);

COMMENT ON TABLE hlth_medications IS
  'Per-record prescribed medication. The Step 6 MedicationService is the canonical writer. Active medications feed the nurse dashboard daily checklist via the Step 6 ScheduleService.';

COMMENT ON COLUMN hlth_medications.is_self_administered IS
  'When true the student carries the medication themselves (epinephrine pen, rescue inhaler). The Step 6 nurse dashboard sorts these out of the daily admin checklist since the nurse only logs administered doses for staff-administered medications.';

COMMENT ON COLUMN hlth_medications.frequency IS
  'Free-form frequency text (twice daily, every 4 hours PRN, before meals). The Step 6 ScheduleService uses hlth_medication_schedule for structured scheduled times. frequency is the prescribing physician note that the nurse renders on the medication card.';

CREATE TABLE IF NOT EXISTS hlth_medication_schedule (
  id              UUID         PRIMARY KEY,
  medication_id   UUID         NOT NULL REFERENCES hlth_medications(id) ON DELETE CASCADE,
  scheduled_time  TIME         NOT NULL,
  day_of_week     SMALLINT,
  notes           TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT hlth_medication_schedule_dow_chk
    CHECK (day_of_week IS NULL OR (day_of_week BETWEEN 0 AND 6))
);

CREATE INDEX IF NOT EXISTS hlth_medication_schedule_medication_idx
  ON hlth_medication_schedule (medication_id);

COMMENT ON TABLE hlth_medication_schedule IS
  'Per-medication daily schedule slot. The Step 6 nurse dashboard renders these as a time-slot checklist for the school day. day_of_week NULL means every day. Specific day_of_week values 0 through 6 follow the ISO Sunday-Saturday convention used elsewhere in the platform.';

COMMENT ON COLUMN hlth_medication_schedule.day_of_week IS
  'Nullable SMALLINT. NULL means every day (the typical case for daily medications). 0 through 6 follows the Cycle 5 sch_periods convention. The Step 6 ScheduleService renders weekday-specific slots as separate rows on the dashboard.';

CREATE TABLE IF NOT EXISTS hlth_medication_administrations (
  id                  UUID         PRIMARY KEY,
  medication_id       UUID         NOT NULL REFERENCES hlth_medications(id) ON DELETE CASCADE,
  schedule_entry_id   UUID,
  administered_by     UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  administered_at     TIMESTAMPTZ,
  dose_given          TEXT,
  notes               TEXT,
  parent_notified     BOOLEAN      NOT NULL DEFAULT false,
  was_missed          BOOLEAN      NOT NULL DEFAULT false,
  missed_reason       TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT hlth_medication_administrations_missed_reason_chk
    CHECK (missed_reason IS NULL OR missed_reason IN (
      'STUDENT_ABSENT', 'STUDENT_REFUSED', 'MEDICATION_UNAVAILABLE', 'PARENT_CANCELLED', 'OTHER'
    )),
  CONSTRAINT hlth_medication_administrations_missed_chk
    CHECK (
      (was_missed = false AND administered_at IS NOT NULL AND missed_reason IS NULL)
      OR
      (was_missed = true AND administered_at IS NULL AND missed_reason IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS hlth_medication_administrations_medication_time_idx
  ON hlth_medication_administrations (medication_id, administered_at DESC);

CREATE INDEX IF NOT EXISTS hlth_medication_administrations_missed_idx
  ON hlth_medication_administrations (schedule_entry_id, was_missed)
  WHERE was_missed = true;

COMMENT ON TABLE hlth_medication_administrations IS
  'Per-dose administration log. The Step 6 AdministrationService writes one row per dose. POST administer creates was_missed equals false with administered_at populated. POST missed creates was_missed equals true with administered_at NULL and missed_reason set. The multi-column missed_chk pins these two shapes and refuses any other state.';

COMMENT ON COLUMN hlth_medication_administrations.schedule_entry_id IS
  'Soft ref to hlth_medication_schedule. Nullable because PRN and unscheduled doses do not link to a schedule slot. Intentionally not a DB-enforced FK so retiring a slot leaves historical administrations pinned to the medication via medication_id.';

COMMENT ON CONSTRAINT hlth_medication_administrations_missed_chk ON hlth_medication_administrations IS
  'Pins administration rows to one of two shapes. Active dose requires was_missed false with administered_at NOT NULL and missed_reason NULL. Missed dose requires was_missed true with administered_at NULL and missed_reason NOT NULL. Any other combination is rejected.';
