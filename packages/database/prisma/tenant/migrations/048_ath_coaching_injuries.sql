/* 048_ath_coaching_injuries.sql
 * Cycle 13 Step 3 — M66 Athletics: coaching staff assignments,
 * injury tracking, the 6-step concussion return-to-play protocol
 * (the safety keystone of Cycle 13), and physician medical
 * clearance documents. Four new tenant base tables completing
 * the Cycle 13 schema phase at 14 tables total.
 *
 *   ath_coaching_assignments   Coaching staff per roster.
 *                              coach_person_id is the universal
 *                              person ref to iam_person so both
 *                              hr_employees-backed staff coaches
 *                              and volunteer coaches (who may not
 *                              be hr_employees) are first-class.
 *                              role is a 4-value enum CHECK
 *                              HEAD_COACH, ASSISTANT_COACH,
 *                              VOLUNTEER_COACH, SPECIALIST.
 *                              stipend_amount is NUMERIC(8,2)
 *                              for the stipend payment per
 *                              ADR-068.
 *
 *   ath_injuries               Per-student injury record.
 *                              severity is a 4-value enum CHECK
 *                              MINOR, MODERATE, SEVERE,
 *                              EMERGENCY. return_to_play_status
 *                              is a 4-value enum CHECK ACTIVE,
 *                              SIDELINED, CONCUSSION_PROTOCOL,
 *                              CLEARED. game_id is nullable for
 *                              practice injuries. health_record_id
 *                              and incident_report_id are soft
 *                              refs to hlth_ and inc_ for cross
 *                              module linking.
 *
 *   ath_concussion_protocol_steps  THE SAFETY KEYSTONE. The
 *                              6-step graduated return-to-play
 *                              process per CDC guidelines.
 *                              step_number 1..6 CHECK with
 *                              UNIQUE(injury_id, step_number).
 *                              minimum_duration_hours defaults
 *                              to 24 hours. The Step 7
 *                              ConcussionProtocolService
 *                              enforces step N+1 cannot start
 *                              until step N is completed AND
 *                              minimum_duration_hours has elapsed.
 *                              The 6 named steps are 1 complete
 *                              rest, 2 light aerobic activity,
 *                              3 sport-specific exercise, 4
 *                              non-contact training drills, 5
 *                              full contact practice, 6 return
 *                              to competition.
 *
 *   ath_medical_clearances     Physician clearance documents.
 *                              document_s3_key is the signed
 *                              upload pointer to the physician
 *                              note PDF. review_status is a
 *                              5-value enum CHECK PENDING,
 *                              ACCEPTED, REJECTED, NOT_SUBMITTED,
 *                              EXPIRED. Required before
 *                              ath_injuries.return_to_play_status
 *                              can flip to CLEARED.
 *
 * Soft cross-schema refs per ADR-001 / ADR-020:
 *   ath_coaching_assignments.coach_person_id -> platform.iam_person(id)
 *   ath_injuries.health_record_id   -> hlth_student_health_records(id) optional
 *   ath_injuries.incident_report_id -> future inc_ tables optional
 *
 * DB-enforced intra-tenant FKs (10 logical):
 *   ath_coaching_assignments.roster_id -> ath_rosters(id) CASCADE
 *   ath_injuries.student_id            -> sis_students(id) CASCADE
 *   ath_injuries.game_id               -> ath_games(id) SET NULL
 *   ath_injuries.logged_by             -> hr_employees(id) NO ACTION
 *   ath_concussion_protocol_steps.injury_id -> ath_injuries(id) CASCADE
 *   ath_concussion_protocol_steps.cleared_by -> hr_employees(id) SET NULL
 *   ath_medical_clearances.injury_id   -> ath_injuries(id) CASCADE
 *   ath_medical_clearances.uploaded_by -> hr_employees(id) NO ACTION
 *   ath_medical_clearances.reviewed_by -> hr_employees(id) SET NULL
 *
 * 0 cross-schema FKs.
 *
 * Splitter discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header avoids semicolons because the splitter
 * cuts on every semicolon regardless of quoting context.
 */

CREATE TABLE IF NOT EXISTS ath_coaching_assignments (
  id                  UUID         PRIMARY KEY,
  roster_id           UUID         NOT NULL REFERENCES ath_rosters(id) ON DELETE CASCADE,
  coach_person_id     UUID         NOT NULL,
  role                TEXT         NOT NULL,
  stipend_amount      NUMERIC(8,2),
  start_date          DATE,
  end_date            DATE,
  is_active           BOOLEAN      NOT NULL DEFAULT true,
  notes               TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ath_coaching_role_chk
    CHECK (role IN ('HEAD_COACH', 'ASSISTANT_COACH', 'VOLUNTEER_COACH', 'SPECIALIST')),
  CONSTRAINT ath_coaching_stipend_chk
    CHECK (stipend_amount IS NULL OR stipend_amount >= 0),
  CONSTRAINT ath_coaching_dates_chk
    CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS ath_coaching_roster_active_idx
  ON ath_coaching_assignments (roster_id, is_active);

CREATE INDEX IF NOT EXISTS ath_coaching_person_idx
  ON ath_coaching_assignments (coach_person_id);

COMMENT ON TABLE ath_coaching_assignments IS
  'Coaching staff per roster. coach_person_id is the universal soft ref to platform.iam_person so both hr_employees-backed staff coaches and volunteer coaches (who may not have an hr_employees row) are first-class participants. role is a 4-value enum CHECK. stipend_amount is NUMERIC(8,2) for the stipend payment when role is HEAD_COACH or ASSISTANT_COACH per ADR-068. is_active flag allows soft-deactivation when a coach steps down mid-season without losing the historical assignment.';

COMMENT ON COLUMN ath_coaching_assignments.coach_person_id IS
  'Soft cross-schema ref to platform.iam_person(id) per ADR-055. Covers volunteer coaches who do not have an hr_employees row. The Step 7 CoachingService is the canonical writer. The Step 8 UI renders the coach name by joining iam_person at read time.';

CREATE TABLE IF NOT EXISTS ath_injuries (
  id                          UUID         PRIMARY KEY,
  student_id                  UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  game_id                     UUID         REFERENCES ath_games(id) ON DELETE SET NULL,
  practice_date               DATE,
  injury_date                 DATE         NOT NULL,
  body_part                   TEXT         NOT NULL,
  injury_description          TEXT         NOT NULL,
  initial_assessment          TEXT,
  action_taken                TEXT,
  severity                    TEXT         NOT NULL,
  health_record_id            UUID,
  incident_report_id          UUID,
  return_to_play_status       TEXT         NOT NULL DEFAULT 'SIDELINED',
  logged_by                   UUID         NOT NULL REFERENCES hr_employees(id),
  logged_at                   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  cleared_at                  TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ath_injuries_severity_chk
    CHECK (severity IN ('MINOR', 'MODERATE', 'SEVERE', 'EMERGENCY')),
  CONSTRAINT ath_injuries_status_chk
    CHECK (return_to_play_status IN ('ACTIVE', 'SIDELINED', 'CONCUSSION_PROTOCOL', 'CLEARED')),
  CONSTRAINT ath_injuries_cleared_chk
    CHECK (
      (return_to_play_status <> 'CLEARED' AND cleared_at IS NULL)
      OR (return_to_play_status = 'CLEARED' AND cleared_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS ath_injuries_student_date_idx
  ON ath_injuries (student_id, injury_date DESC);

CREATE INDEX IF NOT EXISTS ath_injuries_status_idx
  ON ath_injuries (return_to_play_status);

CREATE INDEX IF NOT EXISTS ath_injuries_game_idx
  ON ath_injuries (game_id)
  WHERE game_id IS NOT NULL;

COMMENT ON TABLE ath_injuries IS
  'Per-student injury record. The Step 7 InjuryService is the canonical writer. severity is a 4-value enum CHECK. return_to_play_status walks SIDELINED (initial state) through CONCUSSION_PROTOCOL (when the AD marks the injury as a head-contact concussion — the multi-step return-to-play protocol applies) to CLEARED (the medical clearance has been accepted AND all 6 protocol steps are completed). ACTIVE means the student is still cleared to play despite a minor injury. game_id is nullable for practice injuries — practice_date is set instead. The multi-column cleared_chk keeps cleared_at populated only when return_to_play_status flips to CLEARED.';

COMMENT ON COLUMN ath_injuries.return_to_play_status IS
  'ACTIVE means the student is still cleared to play despite a minor injury. SIDELINED means temporarily off the roster pending healing. CONCUSSION_PROTOCOL means the 6-step graduated return-to-play process is in motion. CLEARED is the post-clearance state — only reachable via the Step 7 MedicalClearanceService accept path AFTER all 6 ath_concussion_protocol_steps are completed when the original status was CONCUSSION_PROTOCOL.';

COMMENT ON COLUMN ath_injuries.health_record_id IS
  'Soft cross-module ref to hlth_student_health_records(id) for cross-module linkage. Optional. The Step 7 service does not enforce a DB FK because health records may be created through the nurse path independently of the athletics path. The future link service will keep the two records aligned.';

CREATE TABLE IF NOT EXISTS ath_concussion_protocol_steps (
  id                          UUID         PRIMARY KEY,
  injury_id                   UUID         NOT NULL REFERENCES ath_injuries(id) ON DELETE CASCADE,
  step_number                 INT          NOT NULL,
  step_name                   TEXT         NOT NULL,
  started_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  minimum_duration_hours      INT          NOT NULL DEFAULT 24,
  completed_at                TIMESTAMPTZ,
  symptom_free                BOOLEAN      NOT NULL DEFAULT false,
  notes                       TEXT,
  cleared_by                  UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ath_concussion_step_chk
    CHECK (step_number BETWEEN 1 AND 6),
  CONSTRAINT ath_concussion_duration_chk
    CHECK (minimum_duration_hours > 0),
  CONSTRAINT ath_concussion_completed_chk
    CHECK (
      (completed_at IS NULL AND cleared_by IS NULL)
      OR (completed_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS ath_concussion_injury_step_uq
  ON ath_concussion_protocol_steps (injury_id, step_number);

CREATE INDEX IF NOT EXISTS ath_concussion_injury_idx
  ON ath_concussion_protocol_steps (injury_id, step_number);

COMMENT ON TABLE ath_concussion_protocol_steps IS
  'THE SAFETY KEYSTONE. The 6-step graduated return-to-play process per CDC guidelines. UNIQUE(injury_id, step_number) so each step exists at most once per injury. step_number is constrained to 1 through 6 with the named steps tracked in step_name (Step 1 complete rest, Step 2 light aerobic activity, Step 3 sport-specific exercise, Step 4 non-contact training drills, Step 5 full contact practice, Step 6 return to competition). The Step 7 ConcussionProtocolService enforces step N+1 cannot start until step N is completed (completed_at populated) AND the minimum_duration_hours has elapsed since step N started_at AND step N has symptom_free=true. minimum_duration_hours defaults to 24 per CDC guidance — schools can override per-step but not below 24.';

COMMENT ON COLUMN ath_concussion_protocol_steps.step_number IS
  'CHECK 1 through 6 inclusive. Step 1 complete rest, Step 2 light aerobic activity, Step 3 sport-specific exercise, Step 4 non-contact training drills, Step 5 full contact practice, Step 6 return to competition.';

COMMENT ON COLUMN ath_concussion_protocol_steps.symptom_free IS
  'The athlete must report no concussion symptoms at the end of each step before progressing. The Step 7 service refuses to start step N+1 unless step N has symptom_free=true. If symptoms recur the AD restarts the protocol from a lower step.';

CREATE TABLE IF NOT EXISTS ath_medical_clearances (
  id                  UUID         PRIMARY KEY,
  injury_id           UUID         NOT NULL REFERENCES ath_injuries(id) ON DELETE CASCADE,
  document_s3_key     TEXT         NOT NULL,
  physician_name      TEXT,
  physician_phone     TEXT,
  clearance_date      DATE         NOT NULL,
  uploaded_by         UUID         NOT NULL REFERENCES hr_employees(id),
  uploaded_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  review_status       TEXT         NOT NULL DEFAULT 'PENDING',
  reviewed_by         UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  reviewed_at         TIMESTAMPTZ,
  review_notes        TEXT,
  expires_at          DATE,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ath_clearances_status_chk
    CHECK (review_status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'NOT_SUBMITTED', 'EXPIRED')),
  CONSTRAINT ath_clearances_reviewed_chk
    CHECK (
      (review_status = 'PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL)
      OR (review_status IN ('ACCEPTED', 'REJECTED') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
      OR (review_status IN ('NOT_SUBMITTED', 'EXPIRED'))
    )
);

CREATE INDEX IF NOT EXISTS ath_clearances_injury_idx
  ON ath_medical_clearances (injury_id);

CREATE INDEX IF NOT EXISTS ath_clearances_status_idx
  ON ath_medical_clearances (review_status);

COMMENT ON TABLE ath_medical_clearances IS
  'Physician clearance documents for return-to-play. The Step 7 MedicalClearanceService is the canonical writer. document_s3_key is the signed upload pointer to the physician note PDF (the upload flow is the same signed-URL pattern as hr_employee_documents from Cycle 4). review_status walks PENDING through ACCEPTED or REJECTED to terminal. NOT_SUBMITTED means the AD created a clearance row before the physician note arrived. EXPIRED means the clearance has aged out (e.g. season-bounded clearance).';

COMMENT ON COLUMN ath_medical_clearances.review_status IS
  'On ACCEPTED, the Step 7 service walks the injury record and flips return_to_play_status to CLEARED ONLY when ALL 6 ath_concussion_protocol_steps are completed (when the injury is CONCUSSION_PROTOCOL). For non-concussion injuries the ACCEPTED clearance immediately flips return_to_play_status to CLEARED. The multi-column reviewed_chk keeps the reviewer fields populated only on ACCEPTED or REJECTED.';
