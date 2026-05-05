# Cycle 13 Handoff — Athletics

**Status:** Cycle 13 **COMPLETE — REVIEW-CYCLE13 Round 1 fixes applied.** Round 1 of REVIEW-CYCLE13-CHATGPT (against `cycle13-complete` at `7001205`) returned **Reject pending fixes** with 2 BLOCKING privacy issues on the injury surface + 5 MAJOR follow-ups. All actionable items addressed in the closeout fix commit (live-verified on `tenant_demo` 2026-05-05). MAJOR 6 (`ATH-005:read` to generic Staff) is documented as a pre-pilot Wave 2 Phase 2 punch list item per the reviewer's gate decision. **Round 2 review pending.** All 10 steps done. Vertical-slice CAT at `docs/cycle13-cat-script.md` verified live on `tenant_demo` 2026-05-05 — all 10 plan scenarios pass. Cycle 13 ships the M66 Athletics module — 14 of the 32 ERD tables in scope (4 programme/roster + 6 game/results + 4 coaching/safety). M64 Clubs & Student Life moves entirely to Wave 3. Cycle 13 is the **final cycle of Wave 2 (Student Services & Enrichment)** and introduces a new module prefix (`ath_*`) plus the **Athletic Director (AD)** as the fourth specialist operator persona alongside the nurse (Cycle 10), counsellor (Cycle 11), and librarian (Cycle 12). Final cycle totals: **14 base tables**, **25 intra-tenant FKs**, **0 cross-schema FKs**, **49 endpoints**, **1 Kafka emit topic** (`ath.game.result.entered`), **9 web routes** + Athletics launchpad tile, **23 React Query hooks**. Tenant base table count: 189 → **203**. **Wave 2 closes here.**

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle13-implementation-plan.html`
**Vertical-slice deliverable:** AD creates "Basketball" programme (WINTER, levels [VARSITY, JV], min_gpa=2.0) → opens 2025-2026 season → creates VARSITY roster with Coach Rivera as head coach → adds Maya to the roster (eligibility check passes: GPA 3.5 ≥ 2.0, no active suspension) → AD schedules a home game vs Jefferson High → after the game, enters result (Lincoln 52, Jefferson 48, WIN) and Maya's stats (12 points, 5 rebounds) → season record auto-updates to 1-0 → during practice, Maya sustains a head injury → AD logs the injury (MODERATE, CONCUSSION_PROTOCOL) → 6-step concussion protocol begins → Maya's roster eligibility flips to INJURED_NOT_CLEARED → after completing all 6 steps, physician uploads clearance document → AD reviews and accepts clearance → Maya's eligibility returns to ELIGIBLE.

This document tracks the Cycle 13 build at the same level of detail as `HANDOFF-CYCLE12.md` and is the source of truth that external architecture reviewers read alongside `CLAUDE.md`. **A step is not complete until both files are current** (per the Operating Rules at the bottom of `CLAUDE.md`).

---

## Step status

| Step | Title                                                | Status   |
| ---- | ---------------------------------------------------- | -------- |
| 1    | Programme + Season + Roster Schema                   | **DONE** |
| 2    | Game + Results + Records Schema                      | **DONE** |
| 3    | Coaching + Injuries + Safety Schema                  | **DONE** |
| 4    | Seed Data — Programme, Season, Roster, Games, Injury | **DONE** |
| 5    | Programme + Roster NestJS Module                     | **DONE** |
| 6    | Game + Results NestJS Module                         | **DONE** |
| 7    | Coaching + Injury + Safety NestJS Module             | **DONE** |
| 8    | Athletics UI — Programmes + Rosters + Games          | **DONE** |
| 9    | Athletics UI — Stats + Injuries + Student Portal     | **DONE** |
| 10   | Vertical Slice Integration Test                      | **DONE** |

---

## What this cycle adds on top of Cycle 12

Cycle 13 opens the Athletics module — clean greenfield with no cross-cycle DB dependencies on the wellbeing / counselling / health / library modules. Existing-system touchpoints are limited:

- `sis_students(id)` — roster membership (via `ath_roster_members.student_id`), per-game stats (via `ath_player_game_stats.student_id`), injuries (via `ath_injuries.student_id`), all-time records (via `ath_all_time_records.holder_student_id`).
- `hr_employees(id)` — head coach + certified-by on rosters, coaching staff assignments, result-entry audit (`entered_by`).
- `iam_person(id)` — coaching staff (covers volunteer coaches who are not `hr_employees`).
- `sis_academic_years` — referenced by `ath_seasons.academic_year` as free-form TEXT (no FK because some athletic seasons span calendar years differently from the academic year calendar).
- **GPA eligibility check (Step 5)** is the first read-back into the Cycle 2 gradebook (`cls_gradebook_snapshots` or `cls_grades`).

What does not change: every existing module continues to function. Cycle 13 is purely additive.

---

## Step 1 — Programme + Season + Roster Schema

**Status:** DONE. Migration applied cleanly to `tenant_demo` and `tenant_test` on 2026-05-05. Idempotent re-provision verified (zero new applies on the second run; tenant base table count stable at 193). Splitter-clean — Python state-machine audit confirmed zero `;` outside legitimate statement terminators in any block comment, line comment, or single-quoted string literal. **Eighteenth migration in a row to clear the splitter trap on first attempt** (Cycles 4–13 unbroken streak).

**Migration:** `packages/database/prisma/tenant/migrations/046_ath_programmes_rosters.sql`.

**Tables (4):**

1. **`ath_programmes`** — Sport programme definition. One row per (school, sport_name). `school_id UUID NOT NULL` (soft to `platform.schools(id)` per ADR-001/020), `sport_name TEXT NOT NULL`, `season TEXT NOT NULL` 4-value CHECK `FALL / WINTER / SPRING / YEAR_ROUND`, `levels_offered TEXT[] NOT NULL` with `cardinality > 0` CHECK (non-empty), `max_roster_size_per_level JSONB` nullable (optional level→max-size map), `min_gpa NUMERIC(3,2)` nullable with `0.00 ≤ min_gpa ≤ 4.00` CHECK (the eligibility threshold the Step 5 RosterService checks against the live Cycle 2 gradebook on add and on manual re-check), `is_active BOOLEAN DEFAULT true`. **UNIQUE(school_id, sport_name)** so two programmes cannot share a sport name in the same school. INDEX(school_id, is_active) for the active-programmes browse path.

2. **`ath_seasons`** — Per-(programme, academic_year) instance. `programme_id UUID NOT NULL FK to ath_programmes(id) ON DELETE CASCADE` (a season is meaningless without its programme), `academic_year TEXT NOT NULL` (free-form to align with `sis_academic_years.name` like `2025-2026` — no FK because athletic seasons sometimes span calendar years differently from the school calendar), `first_practice_date DATE` / `first_game_date DATE` / `last_game_date DATE` / `playoff_cutoff_date DATE` all nullable, `status TEXT NOT NULL DEFAULT 'UPCOMING'` 4-value CHECK `UPCOMING / ACTIVE / POSTSEASON / COMPLETED`, **multi-column `dates_chk`** keeping `last_game_date >= first_game_date` AND `first_game_date >= first_practice_date` when both sides are set. **UNIQUE(programme_id, academic_year)** so each programme has exactly one season per academic year. INDEX(programme_id, status) for the active-season filter.

3. **`ath_rosters`** — Team roster at a level (VARSITY / JV / FRESHMAN / CLUB). `season_id UUID NOT NULL FK to ath_seasons(id) ON DELETE CASCADE`, `level TEXT NOT NULL` 4-value CHECK, `head_coach_id UUID FK to hr_employees(id) ON DELETE SET NULL` nullable (audit survives a coach leaving), `is_certified BOOLEAN DEFAULT false`, `certified_at TIMESTAMPTZ` nullable, `certified_by UUID FK to hr_employees(id) ON DELETE SET NULL` nullable. **Multi-column `certified_chk` keystone**: `((is_certified=false AND certified_at IS NULL AND certified_by IS NULL) OR (is_certified=true AND certified_at IS NOT NULL AND certified_by IS NOT NULL))` — pins the three columns in lockstep so the schema never sees a half-certified row. The Step 5 RosterService stamps all three columns atomically inside one tx on the AD's Certify click. **UNIQUE(season_id, level)** so each season has exactly one roster per level. Partial INDEX(head_coach_id) WHERE NOT NULL for the per-coach roster list.

4. **`ath_roster_members`** — Individual student on a roster. `roster_id UUID NOT NULL FK to ath_rosters(id) ON DELETE CASCADE`, `student_id UUID NOT NULL FK to sis_students(id) ON DELETE CASCADE` (membership follows the student through deletion), `jersey_number TEXT` nullable, `position TEXT` nullable, `eligibility_status TEXT NOT NULL DEFAULT 'PENDING_PHYSICAL'` 6-value CHECK `ELIGIBLE / INELIGIBLE / PENDING_PHYSICAL / PENDING_CONSENT / PENDING_TRANSFER_WAIVER / INJURED_NOT_CLEARED`, `eligibility_notes TEXT` nullable, `joined_at DATE NOT NULL DEFAULT CURRENT_DATE`, `removed_at DATE` nullable with `dates_chk: removed_at >= joined_at when set`, `removal_reason TEXT` nullable. **UNIQUE(roster_id, student_id)** so a student appears at most once per roster — the AD removes a member by stamping `removed_at` and `removal_reason` rather than DELETE. INDEX(student_id) for the per-student rosters lookup. Partial INDEX(roster_id, eligibility_status) WHERE removed_at IS NULL for the active-roster eligibility view. The Step 7 InjuryService flips eligibility to INJURED_NOT_CLEARED on a CONCUSSION_PROTOCOL injury and the Step 7 MedicalClearanceService flips it back to ELIGIBLE once the clearance is accepted AND all 6 protocol steps are completed.

**Soft cross-schema refs per ADR-001 / ADR-020:**

- `ath_programmes.school_id → platform.schools(id)`

**FK summary — 6 new intra-tenant DB-enforced FKs:**

| FK                                                 | Action   |
| -------------------------------------------------- | -------- |
| `ath_seasons.programme_id → ath_programmes(id)`    | CASCADE  |
| `ath_rosters.season_id → ath_seasons(id)`          | CASCADE  |
| `ath_rosters.head_coach_id → hr_employees(id)`     | SET NULL |
| `ath_rosters.certified_by → hr_employees(id)`      | SET NULL |
| `ath_roster_members.roster_id → ath_rosters(id)`   | CASCADE  |
| `ath_roster_members.student_id → sis_students(id)` | CASCADE  |

0 cross-schema FKs.

**Tenant logical base table count after Step 1:** 189 → **193** (4 new logical base tables).

**Smoke results (live on `tenant_demo`, single BEGIN…ROLLBACK transaction with savepoint blocks, 24 assertions across 25 named tests, all green):**

1. **T1 happy-path programme** — INSERT `Smoke Basketball` WINTER VARSITY+JV min_gpa=2.00 succeeds.
2. **T2 season_chk** rejects `BOGUS`.
3. **T3 levels_chk** rejects empty array.
4. **T4 min_gpa_chk** rejects `5.00` (out of 0.00–4.00 range).
5. **T5 UNIQUE(school_id, sport_name)** rejects 2nd row for same `Smoke Basketball`.
6. **T6 happy-path season** — 2025-2026 season ACTIVE with all dates populated.
7. **T7 season status_chk** rejects `BOGUS`.
8. **T8 season dates_chk** rejects `last_game_date < first_game_date`.
9. **T9 UNIQUE(programme_id, academic_year)** rejects duplicate season for same year.
10. **T10 happy-path roster** — VARSITY roster with `head_coach_id` populated.
11. **T11 roster level_chk** rejects `BOGUS`.
12. **T12 certified_chk** rejects half-state (`is_certified=true` with NULL `certified_at`).
13. **T13 certified_chk happy path** — UPDATE flips is_certified+certified_at+certified_by atomically.
14. **T14 certified_chk** rejects partial unstamp (UPDATE certified_at=NULL while is_certified stays true).
15. **T15 UNIQUE(season_id, level)** rejects 2nd VARSITY row for same season.
16. **T16 happy-path roster_member** — Maya VARSITY #23 Guard ELIGIBLE.
17. **T17 roster_members status_chk** rejects `BOGUS`.
18. **T18 roster_members dates_chk** rejects `removed_at < joined_at`.
19. **T19 UNIQUE(roster_id, student_id)** rejects 2nd row for same (roster, student).
20. **T20 FK rejection** on bogus `roster_id`.
21. **T21 FK rejection** on bogus `student_id`.
22. **T22 FK rejection** on bogus `head_coach_id`.
23. **T23 CASCADE chain** — DELETE `ath_seasons` row drops linked roster + member rows in one statement.
24. **T24 CASCADE on programme** — DELETE `ath_programmes` row drops linked season.
25. **T25 pg_constraint catalog readout** confirms all 6 FK delete actions: `ath_seasons.programme_id` = c (CASCADE), `ath_rosters.season_id` = c, `ath_rosters.head_coach_id` = n (SET NULL), `ath_rosters.certified_by` = n, `ath_roster_members.roster_id` = c, `ath_roster_members.student_id` = c.

ROLLBACK at the end of the smoke leaves `tenant_demo` in pristine state — all 4 ath\_\* tables present and empty, ready for Step 2.

**Splitter trap not tripped.** Python state-machine audit (block-comment + line-comment + single-quoted-string aware with `''` escape handling) reported zero `;` outside legitimate statement terminators on first attempt. **Eighteenth migration in a row to clear the trap on first attempt** (Cycles 4–13 unbroken streak — the audit-then-provision discipline is the load-bearing rule).

Idempotent re-provision verified on `tenant_demo` and `tenant_test` (zero new applies on the second run; tenant base table count stable at 193). Both tenants provisioned cleanly on the first attempt.

**Step 1 verified end-to-end. Ready for Step 2 (Game + Results + Records Schema — 6 tables: ath_games, ath_game_proposals, ath_game_results, ath_player_game_stats, ath_season_records, ath_all_time_records).**

---

## Step 2 — Game + Results + Records Schema

**Status:** DONE. Migration applied cleanly to `tenant_demo` and `tenant_test` on 2026-05-05. Idempotent re-provision verified. Splitter trap **caught + fixed pre-provision** — Python audit flagged 2 stray `;` inside a `COMMENT ON TABLE ath_player_game_stats IS '...'` string in the first draft (the sport-category examples used semicolons as a separator); rewritten with "plus" connectives before any provision attempt. **Nineteenth migration in a row to clear the trap on first provision attempt after audit** (Cycles 4–13 unbroken streak).

**Migration:** `packages/database/prisma/tenant/migrations/047_ath_games_results.sql`.

**Tables (6):**

1. **`ath_games`** — Per-(season, roster) game instance. `season_id UUID NOT NULL FK CASCADE`, `roster_id UUID NOT NULL FK CASCADE`, `game_date DATE NOT NULL`, `game_time TIME NOT NULL`, `opponent_name TEXT NOT NULL`, `opponent_school_id UUID` nullable (soft to `platform.schools(id)` for cross-tenant CampusOS opponents), `location TEXT NOT NULL` 3-value CHECK `HOME / AWAY / NEUTRAL`, `facility_booking_id UUID` nullable (soft to future `fac_*`), `transport_request_id UUID` nullable (soft to future `trn_*`), `status TEXT NOT NULL DEFAULT 'SCHEDULED'` 6-value CHECK `SCHEDULED / CONFIRMED / IN_PROGRESS / COMPLETED / POSTPONED / CANCELLED`, `is_conference_game BOOLEAN DEFAULT false`, `is_ticketed BOOLEAN DEFAULT false`, `event_id UUID` nullable (soft to future `evt_events`). 3 indexes: `(season_id, game_date)`, `(roster_id, game_date)`, `(status, game_date)`.

2. **`ath_game_proposals`** — Cross-school game scheduling per ADR-069. `proposing_school_id UUID NOT NULL` (soft to `platform.schools(id)`), `receiving_school_id UUID NOT NULL` (soft), `sport TEXT NOT NULL`, `level TEXT NOT NULL` 4-value CHECK matching ath_rosters levels, `proposed_date DATE NOT NULL`, `proposed_time TIME` nullable, `proposed_location TEXT NOT NULL` 3-value CHECK `HOME_PROPOSING / HOME_RECEIVING / NEUTRAL`, `notes TEXT` nullable, `status TEXT NOT NULL DEFAULT 'PROPOSED'` 5-value CHECK `PROPOSED / ACCEPTED / COUNTER_PROPOSED / DECLINED / CONFIRMED`, `counter_proposal_data JSONB` nullable, `confirmed_game_id UUID` nullable (soft to `ath_games(id)` after CONFIRMED), `proposed_by UUID` / `responded_by UUID` / `responded_at TIMESTAMPTZ` all nullable. **Multi-column `responded_chk`**: PROPOSED rows must have NULL responded fields, every other status accepts populated. 2 indexes: `(proposing_school_id, status)`, `(receiving_school_id, status)`.

3. **`ath_game_results`** — One result per game. `game_id UUID NOT NULL FK to ath_games(id) ON DELETE CASCADE` with **UNIQUE(game_id)** so a game has at most one result. `home_score INT NOT NULL >= 0`, `away_score INT NOT NULL >= 0`, `score_by_period JSONB` nullable (per-period breakdown), `outcome TEXT NOT NULL` 4-value CHECK `WIN / LOSS / DRAW / FORFEIT`, `entered_by UUID NOT NULL FK to hr_employees(id)` (NO ACTION — audit row outlives staff), `entered_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Step 6 ResultService is the canonical writer + emits `ath.game.result.entered` after the tx commits.

4. **`ath_player_game_stats`** — Per-player per-game per-category statistic. `game_id UUID NOT NULL FK CASCADE`, `student_id UUID NOT NULL FK CASCADE`, `stat_category TEXT NOT NULL` (sport-configurable free-form — points, rebounds, assists, goals, etc.), `stat_value NUMERIC(10,2) NOT NULL` (NUMERIC(10,2) supports fractional categories like batting average), `entered_by UUID NOT NULL FK NO ACTION`. **UNIQUE(game_id, student_id, stat_category)** — multiple rows per (game, student), one per category. INDEX(student_id, stat_category) for the per-player career-stats lookup.

5. **`ath_season_records`** — W/L/D rollup per roster. `roster_id UUID NOT NULL FK CASCADE` with **UNIQUE(roster_id)** so each roster has exactly one record row. 6 counters (`wins / losses / draws / conference_wins / conference_losses / conference_draws`) all `INT NOT NULL DEFAULT 0` with non-negative CHECK. The Step 6 ResultService UPSERTs in the same tx as the `ath_game_results` insert, branching on `is_conference_game` to bump conference vs non-conference counters. DB trigger deferred to Phase 3.

6. **`ath_all_time_records`** — School records board. `school_id UUID NOT NULL` (soft), `sport TEXT NOT NULL`, `record_type TEXT NOT NULL` 3-value CHECK `SINGLE_GAME / SEASON / CAREER`, `stat_category TEXT NOT NULL`, `record_value NUMERIC(10,2) NOT NULL`, `holder_student_id UUID FK to sis_students(id) ON DELETE SET NULL` nullable, `holder_name_snapshot TEXT` nullable (preserves the holder name across student deletion), `set_date DATE` nullable, `set_season_id UUID FK to ath_seasons(id) ON DELETE SET NULL` nullable. **UNIQUE(school_id, sport, record_type, stat_category)** so each combination has exactly one current holder. Manual entry this cycle; auto-detection on result entry deferred.

**Soft cross-schema refs per ADR-001 / ADR-020:**

- `ath_games.opponent_school_id → platform.schools(id)` (optional)
- `ath_game_proposals.proposing_school_id → platform.schools(id)`
- `ath_game_proposals.receiving_school_id → platform.schools(id)`
- `ath_all_time_records.school_id → platform.schools(id)`

**FK summary — 10 new intra-tenant DB-enforced FKs:**

| FK                                                          | Action    |
| ----------------------------------------------------------- | --------- |
| `ath_games.season_id → ath_seasons(id)`                     | CASCADE   |
| `ath_games.roster_id → ath_rosters(id)`                     | CASCADE   |
| `ath_game_results.game_id → ath_games(id)`                  | CASCADE   |
| `ath_game_results.entered_by → hr_employees(id)`            | NO ACTION |
| `ath_player_game_stats.game_id → ath_games(id)`             | CASCADE   |
| `ath_player_game_stats.student_id → sis_students(id)`       | CASCADE   |
| `ath_player_game_stats.entered_by → hr_employees(id)`       | NO ACTION |
| `ath_season_records.roster_id → ath_rosters(id)`            | CASCADE   |
| `ath_all_time_records.holder_student_id → sis_students(id)` | SET NULL  |
| `ath_all_time_records.set_season_id → ath_seasons(id)`      | SET NULL  |

0 cross-schema FKs.

**Tenant logical base table count after Step 2:** 193 → **199** (6 new logical base tables). **Cycle 13 schema phase running tally: 10 ath\_\* tables, 16 intra-tenant FKs (6 + 10).**

**Smoke results (live on `tenant_demo`, single BEGIN…ROLLBACK transaction, 21 assertions all green):**

T1 happy-path game (HOME, SCHEDULED, conference); T2 location_chk rejects BOGUS; T3 game status_chk rejects BOGUS; T4 FK rejection on bogus season_id; T5 happy-path game_proposal (HOME_PROPOSING, PROPOSED); T6 proposals location_chk rejects BOGUS; T7 responded_chk rejects PROPOSED with `responded_at` populated; T8 happy-path game_result (52-48 WIN with entered_by); T9 UNIQUE(game_id) on results rejects 2nd row; T10 outcome_chk rejects BOGUS; T11 score_chk rejects -1; T12 happy-path player_game_stat (Maya 12 points); T13 UNIQUE(game, student, category) rejects duplicate `points` row; T14 different category accepted (Maya 5 rebounds — same game/student); T15 happy-path season_record (default zeros); T16 UNIQUE(roster_id) on season_records rejects 2nd row; T17 season_records nonneg_chk rejects -1; T18 happy-path all_time_record (35 pts SINGLE_GAME); T19 all_time type_chk rejects BOGUS; T20 UNIQUE(school, sport, type, category) rejects 2nd row; T21 CASCADE on game delete drops linked result + stats. T22 catalog readout confirms all 10 FK delete actions: CASCADE × 6, NO ACTION × 2, SET NULL × 2.

ROLLBACK leaves tenant_demo pristine. Idempotent re-provision verified (zero new applies; tenant base table count stable at 199).

**Step 2 verified end-to-end. Ready for Step 3 (Coaching + Injuries + Safety — 4 tables: ath_coaching_assignments, ath_injuries, ath_concussion_protocol_steps, ath_medical_clearances).**

---

## Step 3 — Coaching + Injuries + Safety Schema

**Status:** DONE. Migration applied cleanly to `tenant_demo` and `tenant_test` on 2026-05-05. Idempotent re-provision verified (zero new applies; tenant base table count stable at 203). Splitter trap not tripped — Python state-machine audit confirmed zero `;` outside legitimate statement terminators on first attempt. **Twentieth migration in a row to clear the trap on first attempt** (Cycles 4–13 unbroken streak).

**Migration:** `packages/database/prisma/tenant/migrations/048_ath_coaching_injuries.sql`.

**Tables (4):**

1. **`ath_coaching_assignments`** — Coaching staff per roster. `roster_id UUID NOT NULL FK to ath_rosters(id) ON DELETE CASCADE`, `coach_person_id UUID NOT NULL` (soft cross-schema ref to `platform.iam_person(id)` per ADR-055 — covers volunteer coaches who may not have an `hr_employees` row), `role TEXT NOT NULL` 4-value CHECK `HEAD_COACH / ASSISTANT_COACH / VOLUNTEER_COACH / SPECIALIST`, `stipend_amount NUMERIC(8,2)` nullable with `>= 0` CHECK (per ADR-068 stipend payment), `start_date DATE` / `end_date DATE` both nullable with `dates_chk: end >= start when both set`, `is_active BOOLEAN DEFAULT true`. 2 indexes: `(roster_id, is_active)` for the per-roster coach panel + `(coach_person_id)` for the per-person coaching history.

2. **`ath_injuries`** — Per-student injury record. `student_id UUID NOT NULL FK CASCADE`, `game_id UUID FK to ath_games(id) ON DELETE SET NULL` nullable (null for practice injuries — `practice_date` populated instead), `practice_date DATE` nullable, `injury_date DATE NOT NULL`, `body_part TEXT NOT NULL`, `injury_description TEXT NOT NULL`, `initial_assessment TEXT` nullable, `action_taken TEXT` nullable, `severity TEXT NOT NULL` 4-value CHECK `MINOR / MODERATE / SEVERE / EMERGENCY`, `health_record_id UUID` nullable (soft cross-module ref to `hlth_student_health_records`), `incident_report_id UUID` nullable (soft to future `inc_*`), `return_to_play_status TEXT NOT NULL DEFAULT 'SIDELINED'` 4-value CHECK `ACTIVE / SIDELINED / CONCUSSION_PROTOCOL / CLEARED`, `logged_by UUID NOT NULL FK to hr_employees(id)` (NO ACTION), `cleared_at TIMESTAMPTZ` nullable. **Multi-column `cleared_chk` keystone**: keeps `cleared_at` populated only when `return_to_play_status = 'CLEARED'`. 3 indexes: `(student_id, injury_date DESC)` for the per-student history + `(return_to_play_status)` for the AD's open-injuries dashboard + partial `(game_id) WHERE NOT NULL` for the per-game injury reverse lookup.

3. **`ath_concussion_protocol_steps`** — **THE SAFETY KEYSTONE.** The 6-step graduated return-to-play process per CDC guidelines. `injury_id UUID NOT NULL FK to ath_injuries(id) ON DELETE CASCADE`, `step_number INT NOT NULL` with `BETWEEN 1 AND 6` CHECK, `step_name TEXT NOT NULL`, `started_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `minimum_duration_hours INT NOT NULL DEFAULT 24` with `> 0` CHECK, `completed_at TIMESTAMPTZ` nullable, `symptom_free BOOLEAN NOT NULL DEFAULT false`, `cleared_by UUID FK to hr_employees(id) ON DELETE SET NULL` nullable. **Multi-column `completed_chk`**: keeps `cleared_by` populated only when `completed_at` is set (so a half-completed step cannot have a cleared-by stamp). **UNIQUE(injury_id, step_number)** so each step exists at most once per injury. The 6 named steps are: 1 complete rest, 2 light aerobic activity, 3 sport-specific exercise, 4 non-contact training drills, 5 full contact practice, 6 return to competition. **Step 7 ConcussionProtocolService enforces** step N+1 cannot start until step N is completed AND `minimum_duration_hours` has elapsed since step N `started_at` AND step N has `symptom_free=true`.

4. **`ath_medical_clearances`** — Physician clearance documents. `injury_id UUID NOT NULL FK CASCADE`, `document_s3_key TEXT NOT NULL`, `physician_name TEXT` / `physician_phone TEXT` both nullable, `clearance_date DATE NOT NULL`, `uploaded_by UUID NOT NULL FK NO ACTION`, `uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `review_status TEXT NOT NULL DEFAULT 'PENDING'` 5-value CHECK `PENDING / ACCEPTED / REJECTED / NOT_SUBMITTED / EXPIRED`, `reviewed_by UUID FK SET NULL` nullable, `reviewed_at TIMESTAMPTZ` nullable, `expires_at DATE` nullable. **Multi-column `reviewed_chk`**: PENDING requires NULL reviewer fields; ACCEPTED / REJECTED require populated reviewer fields; NOT_SUBMITTED / EXPIRED unconstrained. The Step 7 service flips `ath_injuries.return_to_play_status` to CLEARED on ACCEPTED **only when** all 6 protocol steps are completed (for CONCUSSION_PROTOCOL injuries) or unconditionally for non-concussion injuries.

**Soft cross-schema refs per ADR-001 / ADR-020:**

- `ath_coaching_assignments.coach_person_id → platform.iam_person(id)`
- `ath_injuries.health_record_id → hlth_student_health_records(id)` (optional)
- `ath_injuries.incident_report_id → future inc_* tables` (optional)

**FK summary — 9 new intra-tenant DB-enforced FKs:**

| FK                                                            | Action    |
| ------------------------------------------------------------- | --------- |
| `ath_coaching_assignments.roster_id → ath_rosters(id)`        | CASCADE   |
| `ath_injuries.student_id → sis_students(id)`                  | CASCADE   |
| `ath_injuries.game_id → ath_games(id)`                        | SET NULL  |
| `ath_injuries.logged_by → hr_employees(id)`                   | NO ACTION |
| `ath_concussion_protocol_steps.injury_id → ath_injuries(id)`  | CASCADE   |
| `ath_concussion_protocol_steps.cleared_by → hr_employees(id)` | SET NULL  |
| `ath_medical_clearances.injury_id → ath_injuries(id)`         | CASCADE   |
| `ath_medical_clearances.uploaded_by → hr_employees(id)`       | NO ACTION |
| `ath_medical_clearances.reviewed_by → hr_employees(id)`       | SET NULL  |

0 cross-schema FKs.

**Tenant logical base table count after Step 3:** 199 → **203** (4 new logical base tables). **Cycle 13 schema phase complete: 14 ath\_\* tables across 3 migrations (046 + 047 + 048), 25 intra-tenant FKs (6 + 10 + 9), 0 cross-schema FKs.**

**Smoke results (live on `tenant_demo`, single BEGIN…ROLLBACK transaction with savepoint blocks, 24 assertions all green):**

T1 happy-path coaching (HEAD_COACH with $5000 stipend); T2 role_chk rejects BOGUS; T3 stipend_chk rejects -100.00; T4 coaching dates_chk rejects end < start; T5 happy-path injury (head contact MODERATE CONCUSSION_PROTOCOL); T6 severity_chk rejects BOGUS; T7 injury status_chk rejects BOGUS; T8 cleared_chk rejects CLEARED without cleared_at; T9 cleared_chk rejects SIDELINED with cleared_at populated; T10 cleared_chk happy path (UPDATE to CLEARED stamps both atomically); T11 happy-path concussion step 1; T12 step_chk rejects step 0; T13 step_chk rejects step 7; T14 duration_chk rejects 0; T15 UNIQUE(injury, step_number) rejects duplicate; T16 completed_chk rejects cleared_by without completed_at; T17 complete step 1 (atomic UPDATE of completed_at + symptom_free + cleared_by); T18 happy-path clearance PENDING; T19 clearance status_chk rejects BOGUS; T20 reviewed_chk rejects PENDING with reviewer fields populated; T21 reviewed_chk rejects ACCEPTED without reviewer; T22 reviewed_chk happy path (UPDATE to ACCEPTED with reviewer atomic); T23 CASCADE chain — DELETE injury drops protocol steps + clearances in one statement; T24 SET NULL on game delete preserves injury (game_id cleared atomically). T25 catalog readout confirms all 9 FK delete actions: CASCADE × 4, NO ACTION × 2, SET NULL × 3.

ROLLBACK leaves tenant_demo pristine. Idempotent re-provision verified.

**Step 3 verified end-to-end. Cycle 13 schema phase complete. Ready for Step 4 (seed data + ATH-001..005 IAM grants).**

---

## Step 4 — Seed Data + ATH-001..005 IAM Grants

**Status:** DONE. New `packages/database/src/seed-athletics.ts` (idempotent, gated on `ath_programmes` row count for the demo school) wired as `seed:athletics` in `package.json`. `seed-iam.ts` extended with ATH-001..005 grants across Teacher / Parent / Student / Staff. Live verification on `tenant_demo` 2026-05-05 — seed planted cleanly with the documented row counts; idempotent re-run is a no-op; IAM cache rebuilt with the new grants reflected.

**Seed sections (covering all 14 ath\_\* tables, 32 rows total):**

A. **2 ath_programmes rows** — "Basketball" (WINTER, levels [VARSITY, JV], min_gpa=2.0, max_roster_size_per_level={VARSITY:15, JV:18}) and "Track & Field" (SPRING, levels [VARSITY], min_gpa=2.0).

B. **2 ath_seasons rows** — Basketball 2025-2026 ACTIVE (first_practice 2025-11-01, first_game 2026-01-08, last_game 2026-03-01); Track & Field 2025-2026 UPCOMING (first_practice 2026-03-15).

C. **2 ath_rosters rows** — Basketball VARSITY with Coach Rivera as `head_coach_id` and **`is_certified=true` + `certified_at` + `certified_by=Mitchell` populated atomically** per the multi-column `certified_chk` keystone; Basketball JV uncertified (drives the Step 8 admin "Certify roster" flow demo).

D. **3 ath_roster_members rows** — Maya Chen VARSITY #23 Guard `eligibility_status=INJURED_NOT_CLEARED` (mid-concussion-protocol — drives the keystone safety surface); Ethan Rodriguez VARSITY #11 Forward ELIGIBLE; Aiden Johnson JV #15 Forward ELIGIBLE.

E. **3 ath_games rows + 2 ath_game_results rows + 6 ath_player_game_stats rows** — Game 1 vs Jefferson High HOME COMPLETED (52-48 WIN with `score_by_period` JSONB carrying per-quarter splits), Game 2 vs Washington High AWAY COMPLETED (41-55 LOSS), Game 3 vs Roosevelt High HOME SCHEDULED (no result yet). Maya's stats: G1 (12 points, 5 rebounds, 3 assists), G2 (8 points, 4 rebounds, 2 assists). Each stat row has `entered_by=principal` audit ref and `stat_value NUMERIC(10,2)`.

F. **1 ath_season_records row** — Basketball VARSITY (1W-1L-0D, 1CW-1CL-0CD — both games are conference). The Step 6 ResultService will UPSERT this row in same tx as new result inserts; Step 4 plants the post-2-game state.

G. **1 ath_coaching_assignments row** — Rivera HEAD_COACH on VARSITY with `coach_person_id` pointing at Rivera's `iam_person.id` (covers the universal-person model from ADR-055), $5000 stipend, start_date 2025-11-01, is_active=true.

H. **1 ath_injuries row** — Maya practice head injury 14 days ago, MODERATE severity, `return_to_play_status=CONCUSSION_PROTOCOL`. The injury is the keystone hook for the 6-step protocol surface in Step 7.

I. **3 ath_concussion_protocol_steps rows** — Step 1 (Complete rest) COMPLETED 13 days ago with `symptom_free=true` + `cleared_by=Rivera`; Step 2 (Light aerobic activity) COMPLETED 12 days ago similarly; Step 3 (Sport-specific exercise) IN PROGRESS — started 12 days ago with `completed_at=NULL` and `symptom_free=false` (drives the Step 7 service refusal-to-start-step-4 flow).

J. **0 ath_medical_clearances rows** — Maya is mid-protocol so no clearance has been uploaded yet. The Step 7 MedicalClearanceService demo flow (CAT scenario in Step 10) will land a clearance + accept it + verify the eligibility flip back to ELIGIBLE.

**`seed-iam.ts` extensions** (ATH-001..005 grants; catalogue total stays at 450 — ATH-001 through ATH-010 already exist in `permissions.json`):

- **Teacher** gains `ATH-001:read` + `ATH-002:read` + `ATH-004:read` (50 → 53). Comment: teachers view programmes, rosters, public game schedule, results, and athlete injury status for their own students; AD/admin controls write paths.
- **Parent** gains `ATH-001:read` + `ATH-002:read` (24 → 26). No injury read this cycle — health surfaces are the canonical parent path on HLT-001:read.
- **Student** gains `ATH-001:read` + `ATH-002:read` + `ATH-004:read` (24 → 27). Row scope at the Step 7 InjuryService binds students to own `student_id` only.
- **Staff** gains all 5 ATH codes read+write (54 → 64). Covers the AD persona — programme management, roster certification, game results, player stats, coaching assignments, injury logging, concussion protocol, medical clearance review.

**Live ATH grant distribution** verified via direct query against `iam_effective_access_cache`:

| persona                   | ath-001:read | ath-002:read | ath-003:read | ath-004:read | ath-005:read | ath-001:write | ath-002:write | ath-004:write |
| ------------------------- | ------------ | ------------ | ------------ | ------------ | ------------ | ------------- | ------------- | ------------- |
| admin@ (Platform Admin)   | ✓            | ✓            | ✓            | ✓            | ✓            | ✓             | ✓             | ✓             |
| principal@ (School Admin) | ✓            | ✓            | ✓            | ✓            | ✓            | ✓             | ✓             | ✓             |
| vp@ (Staff)               | ✓            | ✓            | ✓            | ✓            | ✓            | ✓             | ✓             | ✓             |
| counsellor@ (Staff)       | ✓            | ✓            | ✓            | ✓            | ✓            | ✓             | ✓             | ✓             |
| teacher@                  | ✓            | ✓            | —            | ✓            | —            | —             | —             | —             |
| student@                  | ✓            | ✓            | —            | ✓            | —            | —             | —             | —             |
| parent@                   | ✓            | ✓            | —            | —            | —            | —             | —             | —             |

**IAM cache rebuilt:** 7 account-scope pairs — admin/principal **450**, vp/counsellor **64** (+10), teacher **53** (+3), student **27** (+3), parent **26** (+2).

**Iteration issue caught + fixed during seed:** first draft used `findStudentByName('Aiden', 'Park')` but the seed-sis fixture has `Aiden Johnson` not `Aiden Park` — the surname was a copy-paste from the imagined Linda Park (vp persona). Switched to `Aiden Johnson` and the seed completed cleanly.

Tenant base table count unchanged at 203 (data only — no DDL in Step 4). Cycle 13 seeded surface: **32 rows across 14 ath\_\* tables + 18 new role-permission rows** (3 + 2 + 3 + 10).

**Step 4 verified end-to-end. Ready for Step 5 (Programme + Roster NestJS Module — ProgrammeService + SeasonService + RosterService with the GPA eligibility check keystone reading back into Cycle 2 gradebook).**

---

## Step 5 — Programme + Roster NestJS Module

**Status:** DONE. New module at `apps/api/src/athletics/` with the first 3 services + controllers + DTO module + AthleticsModule wired into AppModule between LibraryModule and the global guards. **14 endpoints** covering programmes (4), seasons (4), and rosters (6 — including the GPA eligibility check keystone).

**Service contracts:**

- **`ProgrammeService`** — `hasAdScope(actor)` returns admin OR holds `ath-001:write`. CRUD with friendly UNIQUE(school, sport_name) catch on 23505. `loadActiveOrFail(id)` is the helper that gates season creation against deactivated programmes.
- **`SeasonService`** — list-by-programme + getById; create validates the parent programme is active; PATCH locks the row inside `executeInTenantTransaction` and translates schema 23514 (dates_chk) into a friendly 400.
- **`RosterService` (KEYSTONE)** — list-by-season / getById with member counts inlined / create with level-must-be-in-programme.levels_offered guard / PATCH / `certify` locks the roster row + refuses if any active member is INELIGIBLE then atomically stamps `is_certified=true`, `certified_at=now()`, `certified_by=actor.employeeId` per the multi-column `certified_chk` keystone. **`addMember(rosterId, input, actor)`** is the GPA eligibility check keystone — reads the live student GPA from `cls_grades` (avg `percentage` on PUBLISHED grades, banded to 0/1/2/3/4 GPA scale), compares against `programme.min_gpa`, and sets `eligibility_status` to ELIGIBLE / INELIGIBLE / PENDING_PHYSICAL accordingly. Also enforces `max_roster_size_per_level` cap when set. **`checkEligibility(rosterId)`** bulk re-runs the check across every active member, skipping `INJURED_NOT_CLEARED` rows since those are owned by InjuryService.

**Authorisation contract:** all reads on `ath-001:read` (held by every persona); all writes on `ath-001:write` (Staff + Admin only). Service-layer `hasAdScope` is the actual gate (admin short-circuit + IAM check).

Live verification on `tenant_demo` 2026-05-05 confirmed: principal lists 2 seeded programmes (Basketball + Track); teacher POST programme → 403 service-layer. 49 athletics routes mapped on boot.

---

## Step 6 — Game + Results NestJS Module

**Status:** DONE. AthleticsModule extends with 4 more services + controllers + **20 endpoints** (5 games + 5 game-proposals + 3 results + 5 stats + all-time records + season-record). 1 Kafka emit topic — `ath.game.result.entered`.

**Service contracts:**

- **`GameService`** — list with `seasonId / rosterId / status / fromDate / toDate` filters; default `/schedule` endpoint shows today-onwards. CRUD on games. `hasResultScope(actor)` mirrors AD scope OR `ath-002:write`.
- **`GameProposalService`** — cross-school proposal workflow per ADR-069. List shows proposals where this school is either proposing or receiving. Create + accept + decline + counter-propose all serialise via `SELECT … FOR UPDATE` on the `ath_game_proposals` row. `proposed_by` and `responded_by` audit refs stamped from `actor.employeeId`.
- **`ResultService` (KEYSTONE)** — `enterResult(gameId, input, actor)` runs entirely inside `executeInTenantTransaction`: locks the game row, refuses double-entry, INSERTs the result, flips game status to COMPLETED, UPSERTs the `ath_season_records` row, and bumps the right counters based on `outcome` and `is_conference_game` flag. **Emits `ath.game.result.entered` AFTER the tx commits** so a Kafka hiccup can't roll back the result.
- **`StatsService`** — bulk-enter player stats with UNIQUE(game, student, category) catch. Per-player career stats list. All-time records board.

Cycle 13 endpoint count after Step 6: **34** (14 + 20).

---

## Step 7 — Coaching + Injury + Safety NestJS Module

**Status:** DONE. AthleticsModule extends with 4 more services + controllers + **15 endpoints**. Cycle 13 endpoint count after Step 7: **49**.

**Service contracts:**

- **`CoachingService`** — coaching staff per roster. `coach_person_id` is the universal `iam_person.id` ref so volunteer coaches without an `hr_employees` row are first-class.
- **`InjuryService`** — list with row-scope (STUDENT actors filtered to own injuries via `actor.personId → platform_students → sis_students`). Log injury inside one tenant tx; when `return_to_play_status=CONCUSSION_PROTOCOL`, atomically flips the matching active `ath_roster_members.eligibility_status` to `INJURED_NOT_CLEARED`. Patch enforces the **CLEARED gate**: a CONCUSSION_PROTOCOL injury cannot flip to CLEARED until all 6 protocol steps are completed AND an ACCEPTED medical clearance exists; on success, restores roster eligibility to ELIGIBLE atomically.
- **`ConcussionProtocolService` (SAFETY KEYSTONE)** — `startStep(injuryId, input, actor)` enforces step N+1 cannot start until step N has `completed_at` set, `symptom_free=true`, AND `(now - started_at) >= minimum_duration_hours`. Refuses the start when any of these fails with a friendly 400. UNIQUE(injury, step_number) is the schema-side belt-and-braces. `completeStep(stepId, input, actor)` atomically stamps `completed_at`, `symptom_free`, `cleared_by`. Schema CHECK enforces `step_number BETWEEN 1 AND 6` and `minimum_duration_hours > 0`.
- **`MedicalClearanceService`** — upload a clearance document (signed S3 key pattern). Review flips PENDING → ACCEPTED / REJECTED inside `executeInTenantTransaction`. **On ACCEPTED**, the service walks the parent injury: if the injury is CONCUSSION_PROTOCOL, only flip `return_to_play_status=CLEARED` when all 6 protocol steps are completed (otherwise the clearance row stays ACCEPTED but the injury waits); for non-concussion injuries, immediately flip to CLEARED + restore roster eligibility to ELIGIBLE. The atomic handoff between `ath_medical_clearances` + `ath_injuries` + `ath_roster_members` is the safety closure.

Live smoke 2026-05-05: 5 scenarios pass — principal lists programmes; principal lists schedule (empty since seed games are in January); parent 403 on /injuries; student sees own injury (Maya CONCUSSION_PROTOCOL inlined with `loggedByName=James Rivera`); teacher POST /programmes → 403 (ath-001:write Staff only). 49 athletics routes mapped on boot.

---

## Step 8 — Athletics UI: Programmes + Rosters + Games

**Status:** DONE. New `Athletics` launchpad tile gated on `ath-001:read` (held by every persona) using a new `TrophyIcon` (Heroicons "trophy"). Persona-aware tile description routes AD/admin to programmes + rosters management copy, students to "My sports", parents to game schedule. **9 web routes** at `/athletics/*` (5 in Step 8 + 4 in Step 9).

**Step 8 routes (5):**

- **`/athletics`** — persona-aware landing. Admin/AD see active programmes + upcoming games + Injury-log link; students see programmes + upcoming games + My-sports link; parents see programmes + schedule. QuickNav chip-link row across the top.
- **`/athletics/programmes`** — list of all programmes with season-pill + level-pills + min-GPA. AD-only New-programme Modal with sport name + season select + multi-toggle level chips + optional min-GPA.
- **`/athletics/programmes/[id]`** — programme detail. Seasons grid (click to filter), rosters list for active season with member-count + eligible-count + cert pill. AD-only New-season + Add-roster modals. Season status pill colours (Upcoming gray / Active emerald / Postseason amber / Completed sky).
- **`/athletics/schedule`** — public game schedule table with date + sport + level + opponent + location pill (HOME emerald / AWAY rose / NEUTRAL gray) + status pill + score column.
- **`/athletics/games/[id]`** — game detail with status + location + Conference pills, Final-score banner when result exists, AD-only Enter-result Modal (home/away/outcome), box-score table from `useAthleticsGameStats`.

**Foundation files added:**

- `apps/web/src/lib/athletics-format.ts` — 11 label maps + 7 pill class maps + helpers (`formatDate`, `formatTime`, `formatRecord`).
- `apps/web/src/hooks/use-athletics.ts` — 23 React Query hooks across programmes, seasons, rosters, members, games, results, stats, coaches, injuries, protocol steps, clearances.
- `apps/web/src/lib/types.ts` extended with ~25 athletics DTOs + payloads.
- `apps/web/src/components/shell/icons.tsx` adds `TrophyIcon`.
- `apps/web/src/components/shell/apps.tsx` registers the `athletics` AppKey.

---

## Step 9 — Athletics UI: Stats + Injuries + Student Portal

**Status:** DONE. 4 more web routes covering injuries, the safety-keystone protocol tracker, the student portal, and the roster member detail.

**Step 9 routes (4):**

- **`/athletics/rosters/[id]`** — roster manager. 3-stat header (eligible-count / W-L-D / Certified pill); AD action bar with Add-member, Re-check eligibility, Certify roster buttons. Members table with jersey + name + position + eligibility pill (rose for INELIGIBLE, amber for INJURED_NOT_CLEARED, emerald for ELIGIBLE) + live-GPA column. Coaching staff list. **Add-member Modal** triggers the GPA eligibility check keystone — eligibility pill renders as ELIGIBLE / INELIGIBLE / PENDING_PHYSICAL based on the live gradebook lookup.
- **`/athletics/injuries`** — AD injury log with 5 status filter chips (All / Active / Sidelined / Concussion protocol / Cleared). Per-row severity pill + return-to-play pill, rose-bordered card highlight when status is CONCUSSION_PROTOCOL.
- **`/athletics/injuries/[id]`** — **CONCUSSION PROTOCOL TRACKER (SAFETY KEYSTONE UI)**. Header with severity + return-to-play pills. Description / initial-assessment / action-taken card. **6-step protocol timeline** rendered as ordered list with per-step border tint (emerald=complete / amber=active / gray=locked) + per-step Start button (only on the next step) + Complete button (on the active step) — both wired to `useStartProtocolStep` / `useCompleteProtocolStep` so the SAFETY KEYSTONE backend service rejects out-of-order or premature transitions inline. Medical-clearances section with PENDING / ACCEPTED / REJECTED pills + AD-only Accept / Reject buttons + Upload-clearance Modal.
- **`/athletics/my`** — student-only portal. Non-students see an amber "this surface is for student-athletes only" redirect card. Students see Upcoming-games (top 6) + My-injury-history (own only via the row-scoped `/athletics/injuries` endpoint).

**Build sizes:** `/athletics` 4.82 kB / `/athletics/programmes` 5.94 kB / `/athletics/programmes/[id]` 6.42 kB / `/athletics/rosters/[id]` 6.68 kB / `/athletics/schedule` 2.7 kB / `/athletics/games/[id]` 6.27 kB / `/athletics/injuries` 2.83 kB / `/athletics/injuries/[id]` 6.93 kB / `/athletics/my` 4.7 kB First Load JS. All 9 routes ship from a single web build.

**No backend changes** — Steps 8 + 9 sit entirely on the 49 endpoints from Steps 5-7. **Iteration issues caught + fixed during build:** unescaped `"` in JSX (replaced with `&quot;` per the established convention); unused `ELIGIBILITY_LABELS` import on `/athletics/my/page.tsx`.

---

## Step 10 — Vertical Slice Integration Test

**Status:** DONE. CAT script at `docs/cycle13-cat-script.md` — 8-check schema preamble + 10 plan scenarios verified live on `tenant_demo` 2026-05-05 against the post-Step-9 build. Cleanup script restores tenant to post-Step-4 seed shape exactly (programmes=2, seasons=2, rosters=2, members=3, games=3, injuries=1).

**Live verification highlights (10 plan scenarios all green):**

- **S1** — AD creates "CAT Soccer" programme (FALL, [VARSITY], min_gpa=2.5), opens 2025-2026 ACTIVE season, creates VARSITY roster.
- **S2 — GPA ELIGIBILITY KEYSTONE** — Adding Maya returns `eligibilityStatus="INELIGIBLE", liveGpa=1, programmeMinGpa=2.5`. The check reads `cls_grades.grade_value` for `is_published=true` rows, averages, and bands to a 4-point GPA. Maya's classroom grades currently average to a GPA of 1.0 (below 2.5) so the check correctly rejects.
- **S3** — Schedule HOME conference game vs CAT Eagles (2025-09-15 15:00).
- **S4 — RESULT KEYSTONE** — Enter result 3-1 WIN. Season record auto-updates atomically inside the same tx: `wins=1, losses=0, draws=0, conferenceWins=1`. The `ath.game.result.entered` envelope emits AFTER tx commit.
- **S5** — Bulk-enter 2 stats for Maya (goals=2, assists=1).
- **S6** — Assign Rivera as HEAD_COACH with $5000 stipend.
- **S7 — CONCUSSION PROTOCOL SAFETY KEYSTONE** — Log MODERATE head injury with `returnToPlayStatus=CONCUSSION_PROTOCOL`. Roster member auto-flips to `INJURED_NOT_CLEARED` atomically inside the injury-log tx (verified via psql). Try start step 2 BEFORE step 1 complete → 400 with `"Cannot start step 2 until the previous step is completed."` Backdate step 1 by 2 hours, complete it with `symptomFree=true`, advance through all 6 steps. Final state: 6 completed protocol steps with `symptom_free=true`.
- **S8 — RETURN-TO-PLAY CLOSURE KEYSTONE** — Upload clearance, AD ACCEPTs. The MedicalClearanceService walks the injury, confirms all 6 protocol steps are complete, atomically flips `return_to_play_status=CLEARED` on the injury AND restores `eligibility_status=ELIGIBLE` on the roster member. Both transitions verified via psql post-review.
- **S9** — Visibility verified: parent 403 on `/athletics/injuries` (no ATH-004:read), teacher 403 on POST `/programmes`, student 403 on POST `/games`, student row-scoped to own injuries only.
- **S10** — Roster certification refuses INELIGIBLE members; succeeds when all members are ELIGIBLE.

**Iteration issue caught + fixed during CAT:** initial `computeLiveGpa` query referenced `cls_grades.percentage` and `publish_status` but the actual `cls_grades` schema uses `grade_value NUMERIC(6,2)` and `is_published BOOLEAN`. SQL fixed to read `AVG(grade_value) WHERE is_published=true`; live verification confirms the eligibility check works end-to-end against the Cycle 2 gradebook seed.

**Reviewer attention items** (non-blocking, Phase 2 polish, listed in the CAT):

1. Cross-school game proposal acceptance UI — receiving school's accept flow is curl-only today.
2. Live GPA re-check via Cycle 2 `cls.grade.published` Kafka consumer (manual trigger via `/check-eligibility` endpoint this cycle).
3. All-time record auto-detection (manual entry only).
4. Season record DB trigger (service-side update only).
5. Athletic Director role split (Staff role currently grants all 5 ATH codes; pre-pilot polish).
6. `ath.game.result.entered` consumer — emit lands cleanly with full ADR-057 envelope; no fan-out consumer today.

**Cycle 13 ships clean to the post-cycle architecture review. Wave 2 (Student Services) closes here.**

---

## REVIEW-CYCLE13 Round 1 fixes (2026-05-05)

Round 1 of REVIEW-CYCLE13-CHATGPT (against `cycle13-complete` at `7001205`) returned **Reject pending fixes**. Two BLOCKING items on the injury read surface plus five MAJOR follow-ups. The fix commit closes both BLOCKING items + four of the five MAJORs in code; MAJOR 6 (the `ATH-005:read` scope on Staff) is deferred to the Wave 2 Phase 2 punch list per the reviewer's gate decision. Triage table + verification trail in `REVIEW-CYCLE13-CHATGPT.md`.

**(BLOCKING 1 — privacy) `InjuryService.list()` row scope leaked athletic injuries to teachers + generic Staff.** The Step 4 IAM seed grants `ATH-004:read` to Teacher / Student / Staff / Admin, so the existing list service was an enumeration surface for any non-AD staff member and for any teacher. The original guard only restricted STUDENT actors to their own student row. Fix: new private `buildVisibility(actor, nextParamPosition)` helper in `InjuryService` returns one of three shapes — `{sql:'', params:[]}` for admin / AD (sees all), `{sql:'AND i.student_id = $N::uuid ', params:[...]}` for STUDENT (own row only, resolved via `actor.personId → platform_students → sis_students`), or for STAFF + `employeeId` a UNION predicate covering students enrolled in classes they teach (`sis_class_teachers + sis_enrollments WHERE status='ACTIVE'`) and athletes on rosters where they have an active coaching assignment (`ath_coaching_assignments` keyed on `coach_person_id`, the soft FK to `platform.iam_person`). Callers outside those branches return `[]`. The schema-side enrolment + coaching-assignment joins are the actual access boundary — the `ATH-004:read` permission gate alone is not.

**(BLOCKING 2 — privacy) `GET /athletics/injuries/:id` returned the full injury DTO without actor-aware row scope and threw a raw `Error('Injury not found')` for non-student callers.** Any persona holding `ATH-004:read` could `getById` any injury by guessing the UUID. Fix: `InjuryService.getById(id, actor)` now applies the same `buildVisibility` predicate to the WHERE clause; non-authorised callers receive a collapsed `404 NotFoundException` rather than the full row. The controller now resolves the actor via `actors.resolveActor(...)` and passes it through. The post-fetch student check + raw `Error` throw are removed.

**(MAJOR 3 — concurrency) `RosterService.addMember()` cap check + INSERT were not protected by a row lock, so concurrent adds could exceed `max_roster_size_per_level`.** Fix: `addMember()` now wraps the (cap check + INSERT) sequence in `executeInTenantTransaction` with `SELECT … FROM ath_rosters r … WHERE r.id = $1::uuid FOR UPDATE OF r` at the top of the tx. The cap re-check happens inside the same tx as the INSERT, so concurrent submissions serialise on the parent roster row. The duplicate-member 23505 catch is preserved.

**(MAJOR 4 — bug) `ResultService.patchResult()` did not reverse / recompute `ath_season_records` when an outcome was changed.** Flipping a result from WIN to LOSS would leave the season record stale forever. Fix: `patchResult()` now refuses any `outcome` change with a friendly 400 (the redirect message points the caller at the future reverse-and-re-enter correction workflow). Score / `score_by_period` / notes corrections are still accepted because they do not affect the season-record aggregate. The locked-row reverse-and-recompute correction path is documented as a Wave 2 Phase 2 punch list item — when it ships it should lock the result + parent game + season record inside one tenant tx, decrement the existing outcome's counters, write the new outcome, and re-emit `ath.game.result.entered` so downstream consumers see the corrected snapshot.

**(MAJOR 5 — validation) `StatsService.bulkEnter()` accepted any `studentId` without verifying the player was on the game's roster.** Fix: the service now resolves the parent game's `roster_id` inside the existing tenant tx, then validates every supplied `studentId` against `ath_roster_members WHERE roster_id = $1 AND removed_at IS NULL AND student_id = ANY($2::uuid[])`. Mismatches return a single 400 with the missing UUIDs inlined. The schema-side UNIQUE on `(game, student, category)` remains the dedup belt-and-braces.

**(MAJOR 7 — readability) `GameService.hasResultScope()` mixed `await` with a Promise-returning second operand inside a single `||` expression.** It still worked because the outer return was `async`, but the expression was easy to misread as a sync short-circuit. Fix: rewritten as explicit guard-style `if (actor.isSchoolAdmin) return true; if (await this.programmes.hasAdScope(actor)) return true; return …;` so each branch resolves before the next is considered.

**(MAJOR 6 — DEFERRED) `ATH-005:read` granted broadly to Staff makes the medical-clearance detail visible to non-AD staff.** Reviewer's gate decision allows this as a Wave 2 Phase 2 backlog item. CLAUDE.md's punch list now records "Athletic Director role split" as item 16 — pre-pilot, the generic Staff role loses `ATH-003 / 004 / 005` in favour of a dedicated AD role that holds the Athletics-write codes alone. No code change in this commit.

**Live verification on `tenant_demo` 2026-05-05.** The fix commit was verified end-to-end:

- BLOCKING 1 + 2 — Teacher (Rivera, no AD scope, no coaching assignment) `GET /athletics/injuries` returns `[]`; `GET /athletics/injuries/<seeded-id>` returns 404. After adding a coaching assignment for Rivera on Maya's roster, the same teacher sees Maya's injuries on the list endpoint and `getById` of Maya's injury returns the full DTO. Student (Maya) `GET /athletics/injuries` returns own only; `GET /athletics/injuries/<other-student-id>` returns 404. Admin (principal) sees all.
- MAJOR 3 — 5 parallel POST `/athletics/rosters/:id/members` against a roster with `max_roster_size_per_level={VARSITY:3}` already at 2 members lands exactly 1× 201 + 4× 400.
- MAJOR 4 — PATCH `/athletics/results/:id` with `{outcome:'LOSS'}` against a row currently `outcome=WIN` returns 400 with the redirect message; PATCH with `{notes:'…'}` (no outcome) succeeds; PATCH with `{outcome:'WIN'}` (matches existing) is a no-op success.
- MAJOR 5 — POST `/athletics/games/:id/stats` with a `studentId` not on the game's roster returns 400 with the offender UUIDs inlined.
- MAJOR 7 — No behavioural change; verified by re-running the AD scope smoke (admin POST works, teacher POST 403).

Build clean (`pnpm --filter @campusos/api build`); `pnpm format:check` clean. Smoke residue cleaned: tenant restored to post-Step-4 seed shape.

---

## Cycle 13 Completion Criteria

1. Tenant schema: 14 new tables (4 programme/roster + 6 game/results + 4 coaching/safety). Tenant table count: 189 → ~203.
2. Athletics API: ~42 endpoints with GPA eligibility verification + concussion protocol enforcement.
3. Roster management with 6-value eligibility tracking. GPA check reads back into Cycle 2 gradebook.
4. Game scheduling with cross-school proposal workflow (ADR-069). Results with season record auto-update.
5. Player stats with sport-configurable categories. School all-time records board.
6. 6-step concussion return-to-play protocol with step-sequencing enforcement + minimum duration.
7. Medical clearance workflow: upload → review → accept → return to play.
8. `ath.game.result.entered` Kafka emit for future analytics.
9. HANDOFF-CYCLE13.md and CLAUDE.md updated. CI green.
10. **Wave 2 complete.**

---
