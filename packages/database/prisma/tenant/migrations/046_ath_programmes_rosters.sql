/* 046_ath_programmes_rosters.sql
 * Cycle 13 Step 1 — M66 Athletics: programme + season + roster
 * infrastructure with eligibility tracking. Four new tenant base
 * tables for the Athletics module (the first cycle to ship the
 * ath_ prefix). The Step 2 migration adds games and results. The
 * Step 3 migration adds coaching, injuries, and the 6-step
 * concussion return-to-play protocol.
 *
 *   ath_programmes        Sport definition. One row per sport per
 *                         school. season is a 4-value enum CHECK
 *                         FALL, WINTER, SPRING, YEAR_ROUND. The
 *                         levels_offered TEXT array carries the
 *                         tiers a school runs (VARSITY, JV, etc).
 *                         min_gpa is the eligibility threshold the
 *                         Step 5 RosterService checks against the
 *                         live Cycle 2 gradebook on add and on
 *                         manual re-check.
 *
 *   ath_seasons           Per-(programme, academic_year) instance.
 *                         status is a 4-value enum CHECK UPCOMING,
 *                         ACTIVE, POSTSEASON, COMPLETED. The four
 *                         date columns drive the schedule builder
 *                         and playoff cutoff. UNIQUE(programme_id,
 *                         academic_year) so each programme has
 *                         exactly one season per academic year.
 *
 *   ath_rosters           Team roster at a level (VARSITY, JV,
 *                         FRESHMAN, CLUB). One row per (season,
 *                         level). head_coach_id is a soft FK to
 *                         hr_employees with SET NULL so audit
 *                         survives a coach leaving. is_certified
 *                         flag is the AD final-sign-off after
 *                         eligibility review across all members.
 *
 *   ath_roster_members    Individual student on a roster.
 *                         eligibility_status is a 6-value enum
 *                         CHECK ELIGIBLE, INELIGIBLE,
 *                         PENDING_PHYSICAL, PENDING_CONSENT,
 *                         PENDING_TRANSFER_WAIVER,
 *                         INJURED_NOT_CLEARED. The Step 7
 *                         InjuryService flips the eligibility to
 *                         INJURED_NOT_CLEARED on a CONCUSSION_PROTOCOL
 *                         injury and back to ELIGIBLE once the
 *                         medical clearance is accepted and all 6
 *                         protocol steps are completed.
 *                         UNIQUE(roster_id, student_id) so a
 *                         student appears at most once per roster.
 *                         removed_at is nullable and lets the AD
 *                         soft-deactivate a member without losing
 *                         the membership history.
 *
 * Soft cross-schema refs per ADR-001 / ADR-020:
 *   ath_programmes.school_id -> platform.schools(id)
 *
 * DB-enforced intra-tenant FKs (4 logical):
 *   ath_seasons.programme_id          -> ath_programmes(id) CASCADE
 *     A season is meaningless without its programme.
 *   ath_rosters.season_id             -> ath_seasons(id) CASCADE
 *     Rosters are scoped to a season.
 *   ath_rosters.head_coach_id         -> hr_employees(id) SET NULL
 *     Audit survives a coach leaving.
 *   ath_roster_members.roster_id      -> ath_rosters(id) CASCADE
 *     Members are scoped to a roster.
 *   ath_roster_members.student_id     -> sis_students(id) CASCADE
 *     Membership follows the student through deletion.
 *
 * 0 cross-schema FKs.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header uses commas and periods rather than
 * semicolons because the splitter cuts on every semicolon
 * regardless of quoting context including inside block comments
 * and inside default expressions and inside index expressions.
 */

CREATE TABLE IF NOT EXISTS ath_programmes (
  id                          UUID         PRIMARY KEY,
  school_id                   UUID         NOT NULL,
  sport_name                  TEXT         NOT NULL,
  season                      TEXT         NOT NULL,
  levels_offered              TEXT[]       NOT NULL,
  max_roster_size_per_level   JSONB,
  min_gpa                     NUMERIC(3,2),
  is_active                   BOOLEAN      NOT NULL DEFAULT true,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ath_programmes_season_chk
    CHECK (season IN ('FALL', 'WINTER', 'SPRING', 'YEAR_ROUND')),
  CONSTRAINT ath_programmes_levels_chk
    CHECK (cardinality(levels_offered) > 0),
  CONSTRAINT ath_programmes_min_gpa_chk
    CHECK (min_gpa IS NULL OR (min_gpa >= 0 AND min_gpa <= 4.00))
);

CREATE UNIQUE INDEX IF NOT EXISTS ath_programmes_school_sport_uq
  ON ath_programmes (school_id, sport_name);

CREATE INDEX IF NOT EXISTS ath_programmes_school_active_idx
  ON ath_programmes (school_id, is_active);

COMMENT ON TABLE ath_programmes IS
  'Sport programme definition. One row per (school, sport_name). The Step 5 ProgrammeService is the canonical writer. season groups programmes for the seasonal view (FALL, WINTER, SPRING, YEAR_ROUND for sports that run all year like cheer or strength training). levels_offered is a non-empty TEXT array of the tiers the school runs (VARSITY plus optional JV, FRESHMAN, or CLUB). min_gpa is the eligibility threshold the RosterService checks against the live Cycle 2 gradebook on every add-member call and on the bulk re-check sweep.';

COMMENT ON COLUMN ath_programmes.levels_offered IS
  'Non-empty TEXT array. Allowed values are VARSITY, JV, FRESHMAN, CLUB (validated app-side at Step 5). The schema only enforces non-empty so a programme always has at least one level. The Step 5 RosterService verifies a roster level matches the parent programme levels_offered before insert.';

COMMENT ON COLUMN ath_programmes.max_roster_size_per_level IS
  'Optional JSONB map of level to max size, e.g. {"VARSITY": 15, "JV": 18}. The RosterService is the canonical reader and enforces the cap on add-member when set. Null means no cap.';

COMMENT ON COLUMN ath_programmes.min_gpa IS
  'Optional eligibility threshold (NUMERIC 3.2 in 0.00 to 4.00 range). When set, the Step 5 RosterService.addMember computes the live student GPA from cls_grades or cls_gradebook_snapshots and rejects with eligibility_status INELIGIBLE when the live GPA is below this threshold. Null means no GPA requirement.';

CREATE TABLE IF NOT EXISTS ath_seasons (
  id                      UUID         PRIMARY KEY,
  programme_id            UUID         NOT NULL REFERENCES ath_programmes(id) ON DELETE CASCADE,
  academic_year           TEXT         NOT NULL,
  first_practice_date     DATE,
  first_game_date         DATE,
  last_game_date          DATE,
  playoff_cutoff_date     DATE,
  status                  TEXT         NOT NULL DEFAULT 'UPCOMING',
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ath_seasons_status_chk
    CHECK (status IN ('UPCOMING', 'ACTIVE', 'POSTSEASON', 'COMPLETED')),
  CONSTRAINT ath_seasons_dates_chk
    CHECK (
      (first_game_date IS NULL OR last_game_date IS NULL OR last_game_date >= first_game_date)
      AND (first_practice_date IS NULL OR first_game_date IS NULL OR first_game_date >= first_practice_date)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS ath_seasons_programme_year_uq
  ON ath_seasons (programme_id, academic_year);

CREATE INDEX IF NOT EXISTS ath_seasons_programme_status_idx
  ON ath_seasons (programme_id, status);

COMMENT ON TABLE ath_seasons IS
  'Per-(programme, academic_year) season instance. The Step 5 SeasonService is the canonical writer. status walks UPCOMING (planned, no roster yet) through ACTIVE (rosters certified, games scheduled) through POSTSEASON (playoffs only) to COMPLETED (final state, season records frozen). The four date columns drive the schedule builder and the playoff cutoff display. CASCADE on parent programme delete because a season is meaningless without its programme.';

COMMENT ON COLUMN ath_seasons.academic_year IS
  'Free-form TEXT to align with sis_academic_years.name (e.g. 2025-2026). The Step 5 service does NOT enforce a foreign key here because some athletic seasons span calendar years differently from the school academic year.';

CREATE TABLE IF NOT EXISTS ath_rosters (
  id              UUID         PRIMARY KEY,
  season_id       UUID         NOT NULL REFERENCES ath_seasons(id) ON DELETE CASCADE,
  level           TEXT         NOT NULL,
  head_coach_id   UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  is_certified    BOOLEAN      NOT NULL DEFAULT false,
  certified_at    TIMESTAMPTZ,
  certified_by    UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ath_rosters_level_chk
    CHECK (level IN ('VARSITY', 'JV', 'FRESHMAN', 'CLUB')),
  CONSTRAINT ath_rosters_certified_chk
    CHECK (
      (is_certified = false AND certified_at IS NULL AND certified_by IS NULL)
      OR (is_certified = true AND certified_at IS NOT NULL AND certified_by IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS ath_rosters_season_level_uq
  ON ath_rosters (season_id, level);

CREATE INDEX IF NOT EXISTS ath_rosters_head_coach_idx
  ON ath_rosters (head_coach_id)
  WHERE head_coach_id IS NOT NULL;

COMMENT ON TABLE ath_rosters IS
  'Team roster at a level (VARSITY, JV, FRESHMAN, CLUB). One row per (season, level). The Step 5 RosterService is the canonical writer. head_coach_id is the soft FK to hr_employees with SET NULL so audit history survives a coach leaving. is_certified is the AD final-sign-off boolean — flipped after the AD reviews all member eligibility statuses and signs off. The multi-column certified_chk keystone keeps is_certified, certified_at, certified_by in lockstep so the schema never sees a half-certified row.';

COMMENT ON COLUMN ath_rosters.is_certified IS
  'AD certification flag. False until the AD reviews member eligibility and clicks Certify. The Step 5 RosterService stamps is_certified=true, certified_at=now(), certified_by=actor.employeeId atomically inside one tx per the multi-column certified_chk keystone.';

CREATE TABLE IF NOT EXISTS ath_roster_members (
  id                    UUID         PRIMARY KEY,
  roster_id             UUID         NOT NULL REFERENCES ath_rosters(id) ON DELETE CASCADE,
  student_id            UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  jersey_number         TEXT,
  position              TEXT,
  eligibility_status    TEXT         NOT NULL DEFAULT 'PENDING_PHYSICAL',
  eligibility_notes     TEXT,
  joined_at             DATE         NOT NULL DEFAULT CURRENT_DATE,
  removed_at            DATE,
  removal_reason        TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ath_roster_members_status_chk
    CHECK (eligibility_status IN (
      'ELIGIBLE',
      'INELIGIBLE',
      'PENDING_PHYSICAL',
      'PENDING_CONSENT',
      'PENDING_TRANSFER_WAIVER',
      'INJURED_NOT_CLEARED'
    )),
  CONSTRAINT ath_roster_members_dates_chk
    CHECK (removed_at IS NULL OR removed_at >= joined_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS ath_roster_members_roster_student_uq
  ON ath_roster_members (roster_id, student_id);

CREATE INDEX IF NOT EXISTS ath_roster_members_student_idx
  ON ath_roster_members (student_id);

CREATE INDEX IF NOT EXISTS ath_roster_members_eligibility_idx
  ON ath_roster_members (roster_id, eligibility_status)
  WHERE removed_at IS NULL;

COMMENT ON TABLE ath_roster_members IS
  'Individual student on a roster. The Step 5 RosterService is the canonical writer. eligibility_status drives the live state the AD tracks across the roster — only ELIGIBLE members can play. The Step 7 InjuryService flips the row to INJURED_NOT_CLEARED on a CONCUSSION_PROTOCOL injury and the Step 7 MedicalClearanceService flips it back to ELIGIBLE once the clearance is accepted AND all 6 protocol steps are completed. UNIQUE(roster_id, student_id) so a student appears at most once per roster — the AD removes a member by stamping removed_at and removal_reason rather than DELETE.';

COMMENT ON COLUMN ath_roster_members.eligibility_status IS
  'Live state of the member. ELIGIBLE means cleared to play. INELIGIBLE is the GPA-or-academic-suspension state. PENDING_PHYSICAL, PENDING_CONSENT, PENDING_TRANSFER_WAIVER are pre-eligibility checkpoints the AD walks through. INJURED_NOT_CLEARED is the post-injury state the Step 7 InjuryService stamps on a CONCUSSION_PROTOCOL injury — restored to ELIGIBLE only after the medical clearance is accepted and all 6 concussion protocol steps are completed.';

COMMENT ON COLUMN ath_roster_members.removed_at IS
  'Soft-deactivation. Null while the member is active. Stamped to a date by the AD via PATCH with optional removal_reason. The partial INDEX on (roster_id, eligibility_status) WHERE removed_at IS NULL filters the active-roster view.';
