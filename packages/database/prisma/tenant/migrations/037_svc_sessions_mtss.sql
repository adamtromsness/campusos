/* 037_svc_sessions_mtss.sql
 * Cycle 11 Step 2 — Counselling sessions plus FERPA session notes plus
 * the MTSS / RTI tiered intervention system. Eight tables in one
 * migration. The largest schema migration of Cycle 11.
 *
 *   svc_sessions                   Per-counsellor session log. session
 *                                  type is a 6-value enum CHECK
 *                                  INDIVIDUAL, GROUP, CRISIS,
 *                                  CHECK_IN, PARENT_MEETING,
 *                                  CONSULTATION. status is a 4-value
 *                                  enum CHECK SCHEDULED, COMPLETED,
 *                                  NO_SHOW, CANCELLED. The Step 6
 *                                  SessionService validates that
 *                                  primary_caseload_id is populated
 *                                  for INDIVIDUAL sessions and null
 *                                  for GROUP sessions at the
 *                                  application layer.
 *   svc_session_participants       One row per student per session.
 *                                  Required for GROUP sessions.
 *                                  Optional for INDIVIDUAL sessions
 *                                  since the primary_caseload_id on
 *                                  svc_sessions identifies the
 *                                  student. attendance_status is a
 *                                  3-value enum CHECK ATTENDED,
 *                                  NO_SHOW, LATE.
 *                                  UNIQUE(session_id, student_id) so
 *                                  a student appears at most once per
 *                                  session.
 *   svc_session_notes              FERPA-protected counselling
 *                                  record. One note per student per
 *                                  session via UNIQUE(session_id,
 *                                  student_id). The Step 6
 *                                  SessionNoteService gates every
 *                                  read on the dedicated permission
 *                                  student_counseling_record:read
 *                                  granted only to Staff and Admin.
 *                                  Teachers and parents NEVER see
 *                                  note content. Multi-column
 *                                  locked_chk pins the lock state to
 *                                  one of two shapes. Unlocked
 *                                  requires is_locked false AND
 *                                  locked_at NULL AND locked_by NULL.
 *                                  Locked requires is_locked true AND
 *                                  locked_at NOT NULL AND locked_by
 *                                  NOT NULL. Once locked the Step 6
 *                                  service refuses to update the
 *                                  note. There is no unlock endpoint
 *                                  by design.
 *   svc_mtss_tiers                 Per-(student, year, domain) tier
 *                                  assignment. tier is a 3-value
 *                                  enum CHECK TIER_1, TIER_2,
 *                                  TIER_3. domain is a 4-value enum
 *                                  CHECK ACADEMIC, BEHAVIORAL,
 *                                  SOCIAL_EMOTIONAL, ATTENDANCE.
 *                                  status is a 4-value enum CHECK
 *                                  ACTIVE, EXITED, PROMOTED,
 *                                  DEMOTED. Partial UNIQUE on
 *                                  (student_id, academic_year_id,
 *                                  domain) WHERE status equals ACTIVE
 *                                  pins exactly one active tier per
 *                                  (student, year, domain).
 *   svc_interventions              Per-tier targeted support.
 *                                  intervention_type is a 6-value
 *                                  enum CHECK ACADEMIC_SUPPORT,
 *                                  BEHAVIORAL_SUPPORT,
 *                                  SOCIAL_EMOTIONAL_LEARNING,
 *                                  ATTENDANCE_SUPPORT, COUNSELING,
 *                                  EXTERNAL_SERVICE. status is a
 *                                  3-value enum CHECK ACTIVE,
 *                                  COMPLETED, DISCONTINUED. The Step
 *                                  7 InterventionService is the
 *                                  canonical writer.
 *   svc_intervention_progress      Append-only progress monitoring.
 *                                  No UPDATE method. No DELETE
 *                                  method. score and benchmark are
 *                                  NUMERIC(8,2) so the time-series
 *                                  chart on the Step 9 MTSS detail
 *                                  page can render either rate or
 *                                  count measures.
 *   svc_mtss_team_meetings         RTI team review meeting. meeting
 *                                  is a soft ref to the future
 *                                  mtg_meetings table — the column
 *                                  is nullable and has no DB FK
 *                                  because the target does not exist
 *                                  yet. The Step 7 service fills it
 *                                  in when the M68 Meetings module
 *                                  ships.
 *   svc_mtss_team_meeting_students Links a meeting to the students
 *                                  reviewed at it. outcome is a
 *                                  5-value enum CHECK NO_CHANGE,
 *                                  TIER_UP, TIER_DOWN, EXIT,
 *                                  CONTINUE_WITH_ADJUSTMENT or NULL
 *                                  while the meeting is in progress.
 *                                  UNIQUE(team_meeting_id,
 *                                  student_id) so a student appears
 *                                  at most once per meeting.
 *
 * Soft cross-schema refs per ADR-001 and ADR-020:
 *   svc_sessions.school_id                  -> platform.schools(id)
 *   svc_mtss_tiers.school_id                -> platform.schools(id)
 *   svc_mtss_team_meetings.school_id        -> platform.schools(id)
 *   svc_mtss_team_meetings.meeting_id       -> mtg_meetings(id) future, soft
 *
 * DB-enforced intra-tenant FKs (21 logical):
 *   svc_sessions.counselor_id                       -> hr_employees(id) NO ACTION
 *     Refuses delete of a counsellor with sessions on the log. The
 *     audit value of the session log is preserved.
 *   svc_sessions.primary_caseload_id                -> svc_caseloads(id) SET NULL
 *     Session log survives caseload deletion. Nullable column.
 *   svc_sessions.referral_id                        -> svc_referrals(id) SET NULL
 *     Session log survives referral deletion. Nullable column.
 *   svc_session_participants.session_id             -> svc_sessions(id) CASCADE
 *     A participant row has no meaning without its parent session.
 *   svc_session_participants.student_id             -> sis_students(id) CASCADE
 *     Consistent with the student-referencing table convention.
 *   svc_session_participants.caseload_id            -> svc_caseloads(id) SET NULL
 *     Nullable. Caseload may close while the session participation
 *     row remains as audit.
 *   svc_session_notes.session_id                    -> svc_sessions(id) CASCADE
 *     FERPA notes have no meaning without their session.
 *   svc_session_notes.student_id                    -> sis_students(id) CASCADE
 *     Consistent with the student-referencing table convention.
 *   svc_session_notes.locked_by                     -> hr_employees(id) SET NULL
 *     Audit survives a counsellor leaving the school.
 *   svc_mtss_tiers.student_id                       -> sis_students(id) CASCADE
 *     Consistent with the student-referencing table convention.
 *   svc_mtss_tiers.academic_year_id                 -> sis_academic_years(id) NO ACTION
 *     Refuses delete of an AY with tier assignments.
 *   svc_mtss_tiers.assigned_by                      -> hr_employees(id) NO ACTION
 *     Audit value of the assignment is preserved against employee
 *     deletion. NOT NULL per the plan.
 *   svc_interventions.tier_id                       -> svc_mtss_tiers(id) CASCADE
 *     An intervention has no meaning without its parent tier.
 *   svc_interventions.provider_id                   -> hr_employees(id) SET NULL
 *     Nullable column. Audit survives provider leaving.
 *   svc_intervention_progress.intervention_id       -> svc_interventions(id) CASCADE
 *     Progress has no meaning without its intervention.
 *   svc_intervention_progress.recorded_by           -> hr_employees(id) NO ACTION
 *     Append-only audit. Refuses delete of an employee with progress
 *     entries.
 *   svc_mtss_team_meetings.academic_year_id         -> sis_academic_years(id) NO ACTION
 *     Refuses delete of an AY with team meetings.
 *   svc_mtss_team_meetings.facilitated_by           -> hr_employees(id) NO ACTION
 *     Audit value preserved.
 *   svc_mtss_team_meeting_students.team_meeting_id  -> svc_mtss_team_meetings(id) CASCADE
 *     A meeting-student row has no meaning without its meeting.
 *   svc_mtss_team_meeting_students.student_id       -> sis_students(id) CASCADE
 *     Consistent with the student-referencing table convention.
 *   svc_mtss_team_meeting_students.tier_id          -> svc_mtss_tiers(id) SET NULL
 *     Nullable. Tier may be exited while the meeting record remains.
 *
 * 0 cross-schema FKs.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header. No semicolons inside any string literal or
 * comment per the splitter trap from Cycles 4 through 11. The
 * splitter cuts on every semicolon regardless of quoting context
 * including inside block comments and inside default expressions.
 */

CREATE TABLE IF NOT EXISTS svc_sessions (
  id                       UUID         PRIMARY KEY,
  school_id                UUID         NOT NULL,
  counselor_id             UUID         NOT NULL REFERENCES hr_employees(id),
  session_date             DATE         NOT NULL,
  duration_minutes         INT,
  session_type             TEXT         NOT NULL,
  primary_caseload_id      UUID         REFERENCES svc_caseloads(id) ON DELETE SET NULL,
  referral_id              UUID         REFERENCES svc_referrals(id) ON DELETE SET NULL,
  status                   TEXT         NOT NULL DEFAULT 'SCHEDULED',
  notes                    TEXT,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_sessions_type_chk
    CHECK (session_type IN ('INDIVIDUAL', 'GROUP', 'CRISIS', 'CHECK_IN', 'PARENT_MEETING', 'CONSULTATION')),
  CONSTRAINT svc_sessions_status_chk
    CHECK (status IN ('SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED')),
  CONSTRAINT svc_sessions_duration_chk
    CHECK (duration_minutes IS NULL OR duration_minutes > 0)
);

CREATE INDEX IF NOT EXISTS svc_sessions_counselor_date_idx
  ON svc_sessions (counselor_id, session_date DESC);

CREATE INDEX IF NOT EXISTS svc_sessions_caseload_idx
  ON svc_sessions (primary_caseload_id)
  WHERE primary_caseload_id IS NOT NULL;

COMMENT ON TABLE svc_sessions IS
  'Per-counsellor session log. The Step 6 SessionService is the canonical writer. INDIVIDUAL sessions populate primary_caseload_id which the Step 6 service reads to identify the student. GROUP sessions leave primary_caseload_id null and require participants in svc_session_participants. CRISIS, CHECK_IN, PARENT_MEETING, and CONSULTATION cover the remaining session types from the M27 ERD.';

COMMENT ON COLUMN svc_sessions.primary_caseload_id IS
  'For INDIVIDUAL sessions this points at the caseload that identifies the single student. For GROUP sessions this is null and the participant list lives in svc_session_participants. The Step 6 service validates the shape at the application layer.';

COMMENT ON COLUMN svc_sessions.referral_id IS
  'Optional link to the originating svc_referrals row. Set when a session is a direct follow-up on an accepted referral. ON DELETE SET NULL preserves the session log past referral cleanup.';

CREATE TABLE IF NOT EXISTS svc_session_participants (
  id                  UUID         PRIMARY KEY,
  session_id          UUID         NOT NULL REFERENCES svc_sessions(id) ON DELETE CASCADE,
  student_id          UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  caseload_id         UUID         REFERENCES svc_caseloads(id) ON DELETE SET NULL,
  attendance_status   TEXT         NOT NULL DEFAULT 'ATTENDED',
  notes               TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_session_participants_attendance_chk
    CHECK (attendance_status IN ('ATTENDED', 'NO_SHOW', 'LATE'))
);

CREATE UNIQUE INDEX IF NOT EXISTS svc_session_participants_session_student_uq
  ON svc_session_participants (session_id, student_id);

CREATE INDEX IF NOT EXISTS svc_session_participants_student_session_idx
  ON svc_session_participants (student_id, session_id);

COMMENT ON TABLE svc_session_participants IS
  'Links students to sessions. Required for GROUP sessions and optional for INDIVIDUAL sessions since the primary_caseload_id on svc_sessions identifies the student. UNIQUE(session_id, student_id) so a student appears at most once per session. attendance_status drives the Step 9 attendance pill on the session detail view.';

CREATE TABLE IF NOT EXISTS svc_session_notes (
  id                     UUID         PRIMARY KEY,
  session_id             UUID         NOT NULL REFERENCES svc_sessions(id) ON DELETE CASCADE,
  student_id             UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  notes_text             TEXT         NOT NULL,
  goals_addressed        TEXT[],
  follow_up_required     BOOLEAN      NOT NULL DEFAULT false,
  follow_up_notes        TEXT,
  is_locked              BOOLEAN      NOT NULL DEFAULT false,
  locked_at              TIMESTAMPTZ,
  locked_by              UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_session_notes_locked_chk
    CHECK (
      (is_locked = false AND locked_at IS NULL AND locked_by IS NULL)
      OR
      (is_locked = true AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS svc_session_notes_session_student_uq
  ON svc_session_notes (session_id, student_id);

CREATE INDEX IF NOT EXISTS svc_session_notes_student_idx
  ON svc_session_notes (student_id);

COMMENT ON TABLE svc_session_notes IS
  'FERPA-protected counselling record. The Step 6 SessionNoteService gates every read on the dedicated permission student_counseling_record:read granted only to Staff and Admin in the Step 4 IAM seed. Teachers and parents NEVER see note content. The is_locked flag is irreversible. Once locked the Step 6 service refuses to update the note. There is no unlock endpoint by design. UNIQUE(session_id, student_id) lets a GROUP session carry one note per participant student.';

COMMENT ON COLUMN svc_session_notes.is_locked IS
  'Once true the note is irreversibly immutable. The Step 6 PATCH endpoint rejects any attempt to update a locked note with 400 Note is locked and immutable. Create a follow-up session for additional observations. The lockstep with locked_at and locked_by is enforced by svc_session_notes_locked_chk.';

COMMENT ON CONSTRAINT svc_session_notes_locked_chk ON svc_session_notes IS
  'Pins the lock state to one of two shapes. Unlocked requires is_locked false AND locked_at NULL AND locked_by NULL. Locked requires is_locked true AND locked_at NOT NULL AND locked_by NOT NULL. Any other combination is rejected.';

CREATE TABLE IF NOT EXISTS svc_mtss_tiers (
  id                  UUID         PRIMARY KEY,
  school_id           UUID         NOT NULL,
  student_id          UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  academic_year_id    UUID         NOT NULL REFERENCES sis_academic_years(id),
  tier                TEXT         NOT NULL,
  domain              TEXT         NOT NULL,
  assigned_by         UUID         NOT NULL REFERENCES hr_employees(id),
  assigned_at         DATE         NOT NULL,
  review_date         DATE         NOT NULL,
  exit_date           DATE,
  exit_reason         TEXT,
  status              TEXT         NOT NULL DEFAULT 'ACTIVE',
  notes               TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_mtss_tiers_tier_chk
    CHECK (tier IN ('TIER_1', 'TIER_2', 'TIER_3')),
  CONSTRAINT svc_mtss_tiers_domain_chk
    CHECK (domain IN ('ACADEMIC', 'BEHAVIORAL', 'SOCIAL_EMOTIONAL', 'ATTENDANCE')),
  CONSTRAINT svc_mtss_tiers_status_chk
    CHECK (status IN ('ACTIVE', 'EXITED', 'PROMOTED', 'DEMOTED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS svc_mtss_tiers_active_uq
  ON svc_mtss_tiers (student_id, academic_year_id, domain)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS svc_mtss_tiers_school_tier_status_idx
  ON svc_mtss_tiers (school_id, tier, status);

CREATE INDEX IF NOT EXISTS svc_mtss_tiers_student_year_idx
  ON svc_mtss_tiers (student_id, academic_year_id);

COMMENT ON TABLE svc_mtss_tiers IS
  'Per-(student, year, domain) MTSS / RTI tier assignment. The Step 7 MtssTierService is the canonical writer and emits svc.tier.changed on assignment and on tier value change. The partial UNIQUE keystone svc_mtss_tiers_active_uq pins exactly one active tier per (student, year, domain). When a tier is exited or promoted or demoted the row stays for history while the partial UNIQUE releases.';

COMMENT ON COLUMN svc_mtss_tiers.status IS
  'ACTIVE for the working assignment. EXITED when the student no longer needs the tier in this domain. PROMOTED when moved up a tier (e.g. TIER_2 to TIER_3). DEMOTED when moved down a tier. The PROMOTED and DEMOTED states preserve the prior tier row for history while a new ACTIVE row carries the new tier.';

CREATE TABLE IF NOT EXISTS svc_interventions (
  id                   UUID         PRIMARY KEY,
  tier_id              UUID         NOT NULL REFERENCES svc_mtss_tiers(id) ON DELETE CASCADE,
  intervention_name    TEXT         NOT NULL,
  intervention_type    TEXT         NOT NULL,
  description          TEXT,
  frequency            TEXT,
  start_date           DATE         NOT NULL,
  end_date             DATE,
  provider_id          UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  status               TEXT         NOT NULL DEFAULT 'ACTIVE',
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_interventions_type_chk
    CHECK (intervention_type IN ('ACADEMIC_SUPPORT', 'BEHAVIORAL_SUPPORT', 'SOCIAL_EMOTIONAL_LEARNING', 'ATTENDANCE_SUPPORT', 'COUNSELING', 'EXTERNAL_SERVICE')),
  CONSTRAINT svc_interventions_status_chk
    CHECK (status IN ('ACTIVE', 'COMPLETED', 'DISCONTINUED')),
  CONSTRAINT svc_interventions_dates_chk
    CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS svc_interventions_tier_status_idx
  ON svc_interventions (tier_id, status);

COMMENT ON TABLE svc_interventions IS
  'Per-tier targeted support. Examples include Social Skills Group BEHAVIORAL_SUPPORT, Reading Recovery ACADEMIC_SUPPORT, Mindfulness Practice SOCIAL_EMOTIONAL_LEARNING. The Step 7 InterventionService is the canonical writer. svc_interventions_dates_chk enforces end_date greater than or equal to start_date when both are set.';

CREATE TABLE IF NOT EXISTS svc_intervention_progress (
  id                  UUID         PRIMARY KEY,
  intervention_id     UUID         NOT NULL REFERENCES svc_interventions(id) ON DELETE CASCADE,
  recorded_by         UUID         NOT NULL REFERENCES hr_employees(id),
  recorded_date       DATE         NOT NULL,
  measure_type        TEXT         NOT NULL,
  score               NUMERIC(8,2),
  benchmark           NUMERIC(8,2),
  notes               TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS svc_intervention_progress_intervention_date_idx
  ON svc_intervention_progress (intervention_id, recorded_date DESC);

COMMENT ON TABLE svc_intervention_progress IS
  'Append-only progress monitoring. The Step 7 InterventionService.logProgress is the only writer. No UPDATE method. No DELETE method. score and benchmark are NUMERIC(8,2) so the time-series chart on the Step 9 MTSS detail page can render either rate measures (e.g. words per minute) or count measures (e.g. office referrals per week).';

CREATE TABLE IF NOT EXISTS svc_mtss_team_meetings (
  id                  UUID         PRIMARY KEY,
  school_id           UUID         NOT NULL,
  meeting_id          UUID,
  academic_year_id    UUID         NOT NULL REFERENCES sis_academic_years(id),
  facilitated_by      UUID         NOT NULL REFERENCES hr_employees(id),
  meeting_date        DATE         NOT NULL,
  notes               TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS svc_mtss_team_meetings_school_date_idx
  ON svc_mtss_team_meetings (school_id, meeting_date DESC);

COMMENT ON TABLE svc_mtss_team_meetings IS
  'RTI team review meeting. meeting_id is a soft ref to the future mtg_meetings table — the column is nullable and has no DB FK because the target does not exist yet. The Step 7 service fills it in when the M68 Meetings module ships.';

COMMENT ON COLUMN svc_mtss_team_meetings.meeting_id IS
  'Soft ref to the future mtg_meetings(id) per ADR-001. Nullable. No DB FK because the target table does not exist yet. The future Meetings module migration will tighten this into a real FK in a later cycle.';

CREATE TABLE IF NOT EXISTS svc_mtss_team_meeting_students (
  id                  UUID         PRIMARY KEY,
  team_meeting_id     UUID         NOT NULL REFERENCES svc_mtss_team_meetings(id) ON DELETE CASCADE,
  student_id          UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  tier_id             UUID         REFERENCES svc_mtss_tiers(id) ON DELETE SET NULL,
  outcome             TEXT,
  outcome_notes       TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_mtss_team_meeting_students_outcome_chk
    CHECK (outcome IS NULL OR outcome IN ('NO_CHANGE', 'TIER_UP', 'TIER_DOWN', 'EXIT', 'CONTINUE_WITH_ADJUSTMENT'))
);

CREATE UNIQUE INDEX IF NOT EXISTS svc_mtss_team_meeting_students_uq
  ON svc_mtss_team_meeting_students (team_meeting_id, student_id);

COMMENT ON TABLE svc_mtss_team_meeting_students IS
  'Links a meeting to the students reviewed at it. outcome is nullable to support the in-progress meeting state where students have been added to the agenda but the team has not yet decided on the path forward. UNIQUE(team_meeting_id, student_id) so a student appears at most once per meeting agenda. The tier_id soft link captures which tier the student was on at the time of the meeting and SET NULL on tier delete preserves the historical record.';

COMMENT ON COLUMN svc_mtss_team_meeting_students.outcome IS
  'NO_CHANGE for continue at current tier. TIER_UP for promotion. TIER_DOWN for demotion. EXIT for full release from MTSS. CONTINUE_WITH_ADJUSTMENT for stay at same tier but adjust intervention details. Null while the team is still discussing.';
