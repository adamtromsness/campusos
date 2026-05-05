/* 047_ath_games_results.sql
 * Cycle 13 Step 2 — M66 Athletics: game scheduling, cross-school
 * game proposals (ADR-069), results, per-player per-game stats,
 * season records, and school all-time records. Six new tenant
 * base tables completing the competitive surface on top of the
 * Step 1 programme + season + roster infrastructure.
 *
 *   ath_games               Per-(season, roster, opponent, date)
 *                           game instance. location is a 3-value
 *                           enum CHECK HOME, AWAY, NEUTRAL.
 *                           status is a 6-value enum CHECK
 *                           SCHEDULED, CONFIRMED, IN_PROGRESS,
 *                           COMPLETED, POSTPONED, CANCELLED. Soft
 *                           opponent_school_id ref to platform
 *                           entity cache for cross-tenant CampusOS
 *                           opponents (no DB FK because the
 *                           opposing school may live in another
 *                           tenant or in the platform-side cache
 *                           only). facility_booking_id and
 *                           transport_request_id are soft refs to
 *                           future fac_ and trn_ tables.
 *
 *   ath_game_proposals      Cross-school game scheduling per
 *                           ADR-069. proposing_school_id and
 *                           receiving_school_id are soft refs to
 *                           platform.schools. status is a
 *                           5-value enum CHECK PROPOSED,
 *                           ACCEPTED, COUNTER_PROPOSED, DECLINED,
 *                           CONFIRMED. counter_proposal_data is
 *                           JSONB carrying the receiving school
 *                           counter-offer shape. confirmed_game_id
 *                           is the soft ref to the ath_games row
 *                           the Step 6 GameProposalService
 *                           materialises on CONFIRMED.
 *
 *   ath_game_results        One row per game UNIQUE(game_id) so a
 *                           game has at most one result. outcome
 *                           is a 4-value enum CHECK WIN, LOSS,
 *                           DRAW, FORFEIT. score_by_period is
 *                           JSONB carrying the per-period
 *                           breakdown (e.g. quarters or innings).
 *                           On INSERT the Step 6 ResultService
 *                           also updates ath_season_records in
 *                           the same tx and emits
 *                           ath.game.result.entered.
 *
 *   ath_player_game_stats   Per-player per-game stat. Multiple
 *                           rows per (game, student) — one per
 *                           stat_category. stat_value is
 *                           NUMERIC(10,2) so fractional categories
 *                           like batting average work cleanly.
 *                           UNIQUE(game_id, student_id,
 *                           stat_category) so a category appears
 *                           at most once per (game, player).
 *
 *   ath_season_records      W/L/D rollup per roster.
 *                           UNIQUE(roster_id) one record per
 *                           roster. Service-side update on game
 *                           result entry (trigger deferred to
 *                           Phase 3). Conference splits tracked
 *                           separately via the conference flag on
 *                           ath_games.
 *
 *   ath_all_time_records    School athletic records board.
 *                           record_type is a 3-value enum CHECK
 *                           SINGLE_GAME, SEASON, CAREER.
 *                           UNIQUE(school_id, sport, record_type,
 *                           stat_category) so each combination
 *                           has exactly one current record holder.
 *                           Manual entry this cycle — automatic
 *                           record-detection logic deferred.
 *
 * Soft cross-schema refs per ADR-001 / ADR-020:
 *   ath_games.opponent_school_id      -> platform.schools(id) optional
 *   ath_game_proposals.proposing_school_id -> platform.schools(id)
 *   ath_game_proposals.receiving_school_id -> platform.schools(id)
 *   ath_all_time_records.school_id    -> platform.schools(id)
 *
 * DB-enforced intra-tenant FKs (8 logical):
 *   ath_games.season_id              -> ath_seasons(id) CASCADE
 *   ath_games.roster_id              -> ath_rosters(id) CASCADE
 *   ath_game_results.game_id         -> ath_games(id) CASCADE
 *   ath_game_results.entered_by      -> hr_employees(id) NO ACTION
 *   ath_player_game_stats.game_id    -> ath_games(id) CASCADE
 *   ath_player_game_stats.student_id -> sis_students(id) CASCADE
 *   ath_player_game_stats.entered_by -> hr_employees(id) NO ACTION
 *   ath_season_records.roster_id     -> ath_rosters(id) CASCADE
 *   ath_all_time_records.holder_student_id -> sis_students(id) SET NULL
 *   ath_all_time_records.set_season_id -> ath_seasons(id) SET NULL
 *
 * 0 cross-schema FKs.
 *
 * Splitter discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header uses commas and periods rather than
 * semicolons because the splitter cuts on every semicolon
 * regardless of quoting context.
 */

CREATE TABLE IF NOT EXISTS ath_games (
  id                      UUID         PRIMARY KEY,
  season_id               UUID         NOT NULL REFERENCES ath_seasons(id) ON DELETE CASCADE,
  roster_id               UUID         NOT NULL REFERENCES ath_rosters(id) ON DELETE CASCADE,
  game_date               DATE         NOT NULL,
  game_time               TIME         NOT NULL,
  opponent_name           TEXT         NOT NULL,
  opponent_school_id      UUID,
  location                TEXT         NOT NULL,
  facility_booking_id     UUID,
  transport_request_id    UUID,
  status                  TEXT         NOT NULL DEFAULT 'SCHEDULED',
  is_conference_game      BOOLEAN      NOT NULL DEFAULT false,
  is_ticketed             BOOLEAN      NOT NULL DEFAULT false,
  event_id                UUID,
  notes                   TEXT,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ath_games_location_chk
    CHECK (location IN ('HOME', 'AWAY', 'NEUTRAL')),
  CONSTRAINT ath_games_status_chk
    CHECK (status IN ('SCHEDULED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'POSTPONED', 'CANCELLED'))
);

CREATE INDEX IF NOT EXISTS ath_games_season_date_idx
  ON ath_games (season_id, game_date);

CREATE INDEX IF NOT EXISTS ath_games_roster_date_idx
  ON ath_games (roster_id, game_date);

CREATE INDEX IF NOT EXISTS ath_games_status_date_idx
  ON ath_games (status, game_date);

COMMENT ON TABLE ath_games IS
  'Per-(season, roster) game instance. The Step 6 GameService is the canonical writer. status walks SCHEDULED (AD scheduled, awaiting opponent confirmation) through CONFIRMED (both schools agreed) through IN_PROGRESS (game-day) to COMPLETED (final score entered). POSTPONED is a paused state pending rescheduling. CANCELLED is terminal. opponent_school_id is a soft ref to a platform-side schools cache for cross-tenant CampusOS opponents (no DB FK). facility_booking_id and transport_request_id are forward-compatible soft refs to future fac and trn tables.';

COMMENT ON COLUMN ath_games.location IS
  'HOME means the game is hosted at this school. AWAY means at the opponent school. NEUTRAL means at a third-party venue (e.g. a tournament). The location code drives the home/away score interpretation in ath_game_results.';

COMMENT ON COLUMN ath_games.is_conference_game IS
  'When true, the result counts toward the conference W/L record on ath_season_records. The Step 6 ResultService increments either the conference or the non-conference counters based on this flag.';

CREATE TABLE IF NOT EXISTS ath_game_proposals (
  id                          UUID         PRIMARY KEY,
  proposing_school_id         UUID         NOT NULL,
  receiving_school_id         UUID         NOT NULL,
  proposing_roster_id         UUID,
  sport                       TEXT         NOT NULL,
  level                       TEXT         NOT NULL,
  proposed_date               DATE         NOT NULL,
  proposed_time               TIME,
  proposed_location           TEXT         NOT NULL,
  notes                       TEXT,
  status                      TEXT         NOT NULL DEFAULT 'PROPOSED',
  counter_proposal_data       JSONB,
  confirmed_game_id           UUID,
  proposed_by                 UUID,
  responded_by                UUID,
  responded_at                TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ath_proposals_location_chk
    CHECK (proposed_location IN ('HOME_PROPOSING', 'HOME_RECEIVING', 'NEUTRAL')),
  CONSTRAINT ath_proposals_level_chk
    CHECK (level IN ('VARSITY', 'JV', 'FRESHMAN', 'CLUB')),
  CONSTRAINT ath_proposals_status_chk
    CHECK (status IN ('PROPOSED', 'ACCEPTED', 'COUNTER_PROPOSED', 'DECLINED', 'CONFIRMED')),
  CONSTRAINT ath_proposals_responded_chk
    CHECK (
      (status IN ('PROPOSED') AND responded_by IS NULL AND responded_at IS NULL)
      OR (status IN ('ACCEPTED', 'COUNTER_PROPOSED', 'DECLINED', 'CONFIRMED'))
    )
);

CREATE INDEX IF NOT EXISTS ath_proposals_proposing_idx
  ON ath_game_proposals (proposing_school_id, status);

CREATE INDEX IF NOT EXISTS ath_proposals_receiving_idx
  ON ath_game_proposals (receiving_school_id, status);

COMMENT ON TABLE ath_game_proposals IS
  'Cross-school game scheduling per ADR-069. The Step 6 GameProposalService is the canonical writer. status walks PROPOSED through ACCEPTED or COUNTER_PROPOSED or DECLINED to CONFIRMED. counter_proposal_data is a JSONB carrying the receiving school counter-offer shape (e.g. different date or location). On CONFIRMED the service auto-creates an ath_games row in the proposing school tenant and stamps the resulting id into confirmed_game_id. proposing_school_id and receiving_school_id are soft refs to platform.schools because the opposing tenant may live in another schema entirely.';

COMMENT ON COLUMN ath_game_proposals.proposed_location IS
  'HOME_PROPOSING means the game is at the proposing school. HOME_RECEIVING means at the receiving school. NEUTRAL means at a third-party venue. The Step 6 service translates this to ath_games.location depending on which tenant materialises the row.';

CREATE TABLE IF NOT EXISTS ath_game_results (
  id                  UUID         PRIMARY KEY,
  game_id             UUID         NOT NULL REFERENCES ath_games(id) ON DELETE CASCADE,
  home_score          INT          NOT NULL,
  away_score          INT          NOT NULL,
  score_by_period     JSONB,
  outcome             TEXT         NOT NULL,
  notes               TEXT,
  entered_by          UUID         NOT NULL REFERENCES hr_employees(id),
  entered_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ath_results_outcome_chk
    CHECK (outcome IN ('WIN', 'LOSS', 'DRAW', 'FORFEIT')),
  CONSTRAINT ath_results_score_chk
    CHECK (home_score >= 0 AND away_score >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ath_results_game_uq
  ON ath_game_results (game_id);

COMMENT ON TABLE ath_game_results IS
  'One result per game (UNIQUE on game_id). The Step 6 ResultService is the canonical writer. On INSERT the service updates the matching ath_season_records row in the same tx using the outcome field plus the games.is_conference_game flag, then emits ath.game.result.entered AFTER tx commit. score_by_period is a JSONB carrying per-period breakdown (e.g. quarters for basketball, innings for baseball, halves for soccer). entered_by is the hr_employees audit ref — NO ACTION on delete because the audit row outlives the entering staff member.';

COMMENT ON COLUMN ath_game_results.outcome IS
  'WIN means the school team won. LOSS means the school team lost. DRAW means tied. FORFEIT means the game was awarded due to opponent forfeit (no actual game played). The Step 6 service interprets WIN as +1 in wins, LOSS as +1 in losses, DRAW as +1 in draws, FORFEIT counts as a WIN per typical athletic rules.';

CREATE TABLE IF NOT EXISTS ath_player_game_stats (
  id                  UUID         PRIMARY KEY,
  game_id             UUID         NOT NULL REFERENCES ath_games(id) ON DELETE CASCADE,
  student_id          UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  stat_category       TEXT         NOT NULL,
  stat_value          NUMERIC(10,2) NOT NULL,
  notes               TEXT,
  entered_by          UUID         NOT NULL REFERENCES hr_employees(id),
  entered_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ath_stats_game_student_category_uq
  ON ath_player_game_stats (game_id, student_id, stat_category);

CREATE INDEX IF NOT EXISTS ath_stats_student_idx
  ON ath_player_game_stats (student_id, stat_category);

COMMENT ON TABLE ath_player_game_stats IS
  'Per-player per-game per-category statistic. Multiple rows per (game, student) — one per stat_category — UNIQUE(game_id, student_id, stat_category). stat_category is sport-configurable free-form TEXT (points, rebounds, assists for basketball, plus goals, shots_on_goal, saves for soccer, plus runs, hits, errors for baseball). stat_value is NUMERIC(10,2) to support fractional categories like batting average. entered_by is the hr_employees audit ref — NO ACTION on delete.';

COMMENT ON COLUMN ath_player_game_stats.stat_category IS
  'Free-form TEXT. The Step 5 ProgrammeService configures the active categories per sport (e.g. Basketball points/rebounds/assists/steals/blocks). The schema does not enforce the category set so a school can add custom categories like fast_break_points without a schema migration.';

CREATE TABLE IF NOT EXISTS ath_season_records (
  id                      UUID         PRIMARY KEY,
  roster_id               UUID         NOT NULL REFERENCES ath_rosters(id) ON DELETE CASCADE,
  wins                    INT          NOT NULL DEFAULT 0,
  losses                  INT          NOT NULL DEFAULT 0,
  draws                   INT          NOT NULL DEFAULT 0,
  conference_wins         INT          NOT NULL DEFAULT 0,
  conference_losses       INT          NOT NULL DEFAULT 0,
  conference_draws        INT          NOT NULL DEFAULT 0,
  last_updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ath_season_records_nonneg_chk
    CHECK (
      wins >= 0 AND losses >= 0 AND draws >= 0
      AND conference_wins >= 0 AND conference_losses >= 0 AND conference_draws >= 0
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS ath_season_records_roster_uq
  ON ath_season_records (roster_id);

COMMENT ON TABLE ath_season_records IS
  'W/L/D rollup per roster. UNIQUE(roster_id) so each roster has exactly one record row. The Step 6 ResultService is the canonical writer — UPSERT on every game result entry inside the same tx as the result INSERT. Service-side update because automatic record updates via DB trigger are deferred to Phase 3 (the trigger would need to walk both is_conference_game and outcome to choose the right counter to bump).';

CREATE TABLE IF NOT EXISTS ath_all_time_records (
  id                      UUID         PRIMARY KEY,
  school_id               UUID         NOT NULL,
  sport                   TEXT         NOT NULL,
  record_type             TEXT         NOT NULL,
  stat_category           TEXT         NOT NULL,
  record_value            NUMERIC(10,2) NOT NULL,
  holder_student_id       UUID         REFERENCES sis_students(id) ON DELETE SET NULL,
  holder_name_snapshot    TEXT,
  set_date                DATE,
  set_season_id           UUID         REFERENCES ath_seasons(id) ON DELETE SET NULL,
  notes                   TEXT,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ath_all_time_type_chk
    CHECK (record_type IN ('SINGLE_GAME', 'SEASON', 'CAREER'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ath_all_time_records_combo_uq
  ON ath_all_time_records (school_id, sport, record_type, stat_category);

COMMENT ON TABLE ath_all_time_records IS
  'School athletic records board. UNIQUE(school_id, sport, record_type, stat_category) so each combination has exactly one current record holder. The Step 6 service does manual entry this cycle — automatic record-detection logic on game-result entry is deferred to Phase 3. holder_name_snapshot captures the holder name at record-set time so the board renders correctly even if the linked sis_students row is later deleted (SET NULL on FK).';

COMMENT ON COLUMN ath_all_time_records.record_type IS
  'SINGLE_GAME means a single-game record (e.g. most points in a game). SEASON means a single-season record (e.g. most goals in a season). CAREER means an across-multiple-seasons record (e.g. career rebound leader).';
