/*
  P2-15b Step 3 — Engagement + Performance Read Models Schema (M110 Analytics .1, ADR-008 CQRS-lite, ADR-049)

  Nine domain-specific materialised read models for engagement + performance
  modules built across Phases 1 and 2. Single-writer enforced — each table
  is written by exactly one Kafka consumer worker, with the OfficialsReadModelWorker
  being a weekly batch worker (per the plan, officials assignment volume is
  small and a weekly aggregation roll-up is the right cadence). All reads
  route to the read replica.

  Tables in this migration:

   - rpt_enr_funnel_summary         — enr.application.*, enr.offer.*, enr.tour.booked
   - rpt_ath_season_summary         — ath.game.completed, ath.roster.updated
   - rpt_officials_marketplace      — ath_official_assignments (WEEKLY BATCH)
   - rpt_game_results               — ath.game.completed (per-game grain)
   - rpt_grp_engagement_summary     — grp.post.created, grp.member.joined
   - rpt_pub_distribution_summary   — pub.publication.published
   - rpt_ext_service_summary        — ext.activity.completed
   - rpt_msg_communication_metrics  — msg.message.sent, msg.broadcast.sent
   - rpt_wellbeing_domain_trends    — svc.wellbeing.response.submitted
                                       (renamed from plan rpt_wellbeing_trends
                                       because Cycle 29 already shipped a table
                                       at that name with a different grain.
                                       Both are privacy-safe — neither carries
                                       student_id. See HANDOFF-P2C15.md
                                       Naming Decisions section.)

  PRIVACY INVARIANT (rpt_wellbeing_domain_trends):
   - No student_id column. Aggregation grain is school + grade_level + domain
     + period. A schema-side absence check is the wire-level guarantee — the
     P2C15 review-notes CI check greps the migration for `student_id` inside
     the table body and refuses to land any migration that breaks the rule.

  Period columns: DATE anchored at the first day of the month for monthly
  grain. Per-game rows use the actual game_date. JSONB used for
  statistical_leaders (top-3 stat lines per game) and any other nested
  rollup. No cross-schema FKs. school_id is a soft ref to platform.schools
  per ADR-001/020.

  Splitter discipline: every comment is a block comment — no stray semicolons
  inside string literals or COMMENT bodies.
*/

/* ========================================================================
   1. rpt_enr_funnel_summary
   Source: enr.application.submitted/reviewed, enr.offer.issued/accepted/declined, enr.tour.booked
   Owner:  EnrolmentReadModelWorker
   ====================================================================== */
CREATE TABLE IF NOT EXISTS rpt_enr_funnel_summary (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  academic_year TEXT NOT NULL,
  applications_received INT NOT NULL DEFAULT 0,
  tours_booked INT NOT NULL DEFAULT 0,
  offers_made INT NOT NULL DEFAULT 0,
  offers_accepted INT NOT NULL DEFAULT 0,
  enrolled INT NOT NULL DEFAULT 0,
  waitlisted INT NOT NULL DEFAULT 0,
  conversion_rate NUMERIC(5,4),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_enr_applications_chk CHECK (applications_received >= 0),
  CONSTRAINT rpt_enr_tours_chk CHECK (tours_booked >= 0),
  CONSTRAINT rpt_enr_offers_made_chk CHECK (offers_made >= 0),
  CONSTRAINT rpt_enr_offers_accepted_chk CHECK (offers_accepted >= 0),
  CONSTRAINT rpt_enr_enrolled_chk CHECK (enrolled >= 0),
  CONSTRAINT rpt_enr_waitlisted_chk CHECK (waitlisted >= 0),
  CONSTRAINT rpt_enr_conversion_chk CHECK (conversion_rate IS NULL OR (conversion_rate >= 0 AND conversion_rate <= 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_enr_funnel_summary_uq
  ON rpt_enr_funnel_summary (school_id, academic_year);

CREATE INDEX IF NOT EXISTS rpt_enr_funnel_school_idx
  ON rpt_enr_funnel_summary (school_id, academic_year DESC);

COMMENT ON TABLE rpt_enr_funnel_summary IS
  'Per-(school, academic_year) enrolment funnel rollup. Written exclusively by EnrolmentReadModelWorker. conversion_rate = enrolled / applications_received when applications_received > 0.';


/* ========================================================================
   2. rpt_ath_season_summary
   Source: ath.game.completed, ath.roster.updated
   Owner:  AthleticsReadModelWorker
   ====================================================================== */
CREATE TABLE IF NOT EXISTS rpt_ath_season_summary (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  season_id UUID NOT NULL,
  programme_id UUID NOT NULL,
  games_played INT NOT NULL DEFAULT 0,
  wins INT NOT NULL DEFAULT 0,
  losses INT NOT NULL DEFAULT 0,
  draws INT NOT NULL DEFAULT 0,
  win_rate NUMERIC(5,4),
  total_roster_size INT NOT NULL DEFAULT 0,
  injury_count INT NOT NULL DEFAULT 0,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_ath_games_chk CHECK (games_played >= 0),
  CONSTRAINT rpt_ath_wins_chk CHECK (wins >= 0),
  CONSTRAINT rpt_ath_losses_chk CHECK (losses >= 0),
  CONSTRAINT rpt_ath_draws_chk CHECK (draws >= 0),
  CONSTRAINT rpt_ath_winrate_chk CHECK (win_rate IS NULL OR (win_rate >= 0 AND win_rate <= 1)),
  CONSTRAINT rpt_ath_roster_chk CHECK (total_roster_size >= 0),
  CONSTRAINT rpt_ath_injury_chk CHECK (injury_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_ath_season_summary_uq
  ON rpt_ath_season_summary (school_id, season_id, programme_id);

CREATE INDEX IF NOT EXISTS rpt_ath_season_school_idx
  ON rpt_ath_season_summary (school_id);

COMMENT ON TABLE rpt_ath_season_summary IS
  'Per-(school, season, programme) athletics rollup. Written exclusively by AthleticsReadModelWorker consuming ath.game.completed (the same worker also upserts rpt_game_results — split-write to two tables is allowed under the single-writer rule because the worker is still the single writer to both targets).';


/* ========================================================================
   3. rpt_officials_marketplace
   Source: ath_official_assignments aggregated WEEKLY BATCH
   Owner:  OfficialsReadModelWorker.materialise()
   ====================================================================== */
CREATE TABLE IF NOT EXISTS rpt_officials_marketplace (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  period DATE NOT NULL,
  total_assignments INT NOT NULL DEFAULT 0,
  fill_rate NUMERIC(5,4),
  avg_cost_per_game NUMERIC(10,2),
  avg_official_rating NUMERIC(3,2),
  avg_school_rating NUMERIC(3,2),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_off_total_chk CHECK (total_assignments >= 0),
  CONSTRAINT rpt_off_fill_chk CHECK (fill_rate IS NULL OR (fill_rate >= 0 AND fill_rate <= 1)),
  CONSTRAINT rpt_off_cost_chk CHECK (avg_cost_per_game IS NULL OR avg_cost_per_game >= 0),
  CONSTRAINT rpt_off_official_rating_chk CHECK (avg_official_rating IS NULL OR (avg_official_rating >= 0 AND avg_official_rating <= 5)),
  CONSTRAINT rpt_off_school_rating_chk CHECK (avg_school_rating IS NULL OR (avg_school_rating >= 0 AND avg_school_rating <= 5))
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_officials_marketplace_uq
  ON rpt_officials_marketplace (school_id, period);

COMMENT ON TABLE rpt_officials_marketplace IS
  'Per-(school, period) officials marketplace rollup. WEEKLY BATCH materialisation by OfficialsReadModelWorker.materialise() — not a live consumer (per the plan, assignment volume is small and a weekly aggregation cadence avoids unnecessary write churn). period is the first day of the ISO week (Monday).';


/* ========================================================================
   4. rpt_game_results
   Source: ath.game.completed (per-game grain)
   Owner:  AthleticsReadModelWorker (same writer as rpt_ath_season_summary)
   ====================================================================== */
CREATE TABLE IF NOT EXISTS rpt_game_results (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  game_id UUID NOT NULL,
  sport TEXT NOT NULL,
  home_score INT NOT NULL DEFAULT 0,
  away_score INT NOT NULL DEFAULT 0,
  result TEXT NOT NULL,
  season_id UUID NOT NULL,
  statistical_leaders JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_game_result_chk CHECK (result IN ('WIN','LOSS','DRAW')),
  CONSTRAINT rpt_game_home_chk CHECK (home_score >= 0),
  CONSTRAINT rpt_game_away_chk CHECK (away_score >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_game_results_uq
  ON rpt_game_results (school_id, game_id);

CREATE INDEX IF NOT EXISTS rpt_game_results_season_idx
  ON rpt_game_results (school_id, season_id);

COMMENT ON TABLE rpt_game_results IS
  'Per-(school, game) athletics results. Written exclusively by AthleticsReadModelWorker consuming ath.game.completed. statistical_leaders JSONB holds the top-3 stat lines for the game (player_id, name, stat_type, value).';


/* ========================================================================
   5. rpt_grp_engagement_summary
   Source: grp.post.created, grp.member.joined
   Owner:  GroupsReadModelWorker
   ====================================================================== */
CREATE TABLE IF NOT EXISTS rpt_grp_engagement_summary (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  group_id UUID NOT NULL,
  period DATE NOT NULL,
  total_members INT NOT NULL DEFAULT 0,
  active_members INT NOT NULL DEFAULT 0,
  posts_count INT NOT NULL DEFAULT 0,
  comments_count INT NOT NULL DEFAULT 0,
  engagement_rate NUMERIC(5,4),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_grp_total_chk CHECK (total_members >= 0),
  CONSTRAINT rpt_grp_active_chk CHECK (active_members >= 0),
  CONSTRAINT rpt_grp_posts_chk CHECK (posts_count >= 0),
  CONSTRAINT rpt_grp_comments_chk CHECK (comments_count >= 0),
  CONSTRAINT rpt_grp_engagement_chk CHECK (engagement_rate IS NULL OR (engagement_rate >= 0 AND engagement_rate <= 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_grp_engagement_summary_uq
  ON rpt_grp_engagement_summary (school_id, group_id, period);

CREATE INDEX IF NOT EXISTS rpt_grp_engagement_school_period_idx
  ON rpt_grp_engagement_summary (school_id, period DESC);

COMMENT ON TABLE rpt_grp_engagement_summary IS
  'Per-(school, group, period) groups engagement rollup. Written exclusively by GroupsReadModelWorker. engagement_rate = active_members / total_members when total_members > 0.';


/* ========================================================================
   6. rpt_pub_distribution_summary
   Source: pub.publication.published
   Owner:  PublicationsReadModelWorker
   ====================================================================== */
CREATE TABLE IF NOT EXISTS rpt_pub_distribution_summary (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  period DATE NOT NULL,
  publications_count INT NOT NULL DEFAULT 0,
  total_views INT NOT NULL DEFAULT 0,
  total_downloads INT NOT NULL DEFAULT 0,
  avg_time_to_publish_days NUMERIC(8,2),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_pub_count_chk CHECK (publications_count >= 0),
  CONSTRAINT rpt_pub_views_chk CHECK (total_views >= 0),
  CONSTRAINT rpt_pub_downloads_chk CHECK (total_downloads >= 0),
  CONSTRAINT rpt_pub_time_chk CHECK (avg_time_to_publish_days IS NULL OR avg_time_to_publish_days >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_pub_distribution_summary_uq
  ON rpt_pub_distribution_summary (school_id, period);

COMMENT ON TABLE rpt_pub_distribution_summary IS
  'Per-(school, period) publications distribution rollup. Written exclusively by PublicationsReadModelWorker consuming pub.publication.published.';


/* ========================================================================
   7. rpt_ext_service_summary
   Source: ext.activity.completed
   Owner:  ClubsReadModelWorker
   ====================================================================== */
CREATE TABLE IF NOT EXISTS rpt_ext_service_summary (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  academic_year TEXT NOT NULL,
  club_id UUID NOT NULL,
  total_members INT NOT NULL DEFAULT 0,
  attendance_rate NUMERIC(5,4),
  events_held INT NOT NULL DEFAULT 0,
  budget_spent NUMERIC(14,2) NOT NULL DEFAULT 0,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_ext_members_chk CHECK (total_members >= 0),
  CONSTRAINT rpt_ext_attendance_chk CHECK (attendance_rate IS NULL OR (attendance_rate >= 0 AND attendance_rate <= 1)),
  CONSTRAINT rpt_ext_events_chk CHECK (events_held >= 0),
  CONSTRAINT rpt_ext_budget_chk CHECK (budget_spent >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_ext_service_summary_uq
  ON rpt_ext_service_summary (school_id, academic_year, club_id);

CREATE INDEX IF NOT EXISTS rpt_ext_service_school_year_idx
  ON rpt_ext_service_summary (school_id, academic_year);

COMMENT ON TABLE rpt_ext_service_summary IS
  'Per-(school, academic_year, club) extracurricular activities rollup. Written exclusively by ClubsReadModelWorker consuming ext.activity.completed.';


/* ========================================================================
   8. rpt_msg_communication_metrics
   Source: msg.message.sent, msg.broadcast.sent
   Owner:  CommsReadModelWorker
   ====================================================================== */
CREATE TABLE IF NOT EXISTS rpt_msg_communication_metrics (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  period DATE NOT NULL,
  messages_sent INT NOT NULL DEFAULT 0,
  broadcasts_sent INT NOT NULL DEFAULT 0,
  delivery_rate NUMERIC(5,4),
  read_rate NUMERIC(5,4),
  avg_response_time_hours NUMERIC(10,2),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_msg_messages_chk CHECK (messages_sent >= 0),
  CONSTRAINT rpt_msg_broadcasts_chk CHECK (broadcasts_sent >= 0),
  CONSTRAINT rpt_msg_delivery_chk CHECK (delivery_rate IS NULL OR (delivery_rate >= 0 AND delivery_rate <= 1)),
  CONSTRAINT rpt_msg_read_chk CHECK (read_rate IS NULL OR (read_rate >= 0 AND read_rate <= 1)),
  CONSTRAINT rpt_msg_response_chk CHECK (avg_response_time_hours IS NULL OR avg_response_time_hours >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_msg_communication_metrics_uq
  ON rpt_msg_communication_metrics (school_id, period);

COMMENT ON TABLE rpt_msg_communication_metrics IS
  'Per-(school, period) communications metrics rollup. Written exclusively by CommsReadModelWorker consuming msg.message.sent and msg.broadcast.sent.';


/* ========================================================================
   9. rpt_wellbeing_domain_trends
   Source: svc.wellbeing.response.submitted (LIVE CONSUMER)
   Owner:  WellbeingReadModelWorker

   PRIVACY KEYSTONE: this table aggregates by (school, period,
   grade_level, domain) only — NO student_id column, no individual
   attribution at any grain. The Cycle 11.1 wellbeing module is the
   most sensitive data source in the platform, and the read model is
   strictly aggregate. The CI parity check refuses to land any migration
   that introduces student_id on this table.
   ====================================================================== */
CREATE TABLE IF NOT EXISTS rpt_wellbeing_domain_trends (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  period DATE NOT NULL,
  grade_level TEXT NOT NULL,
  domain TEXT NOT NULL,
  avg_score NUMERIC(3,1),
  response_count INT NOT NULL DEFAULT 0,
  below_threshold_count INT NOT NULL DEFAULT 0,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_wellbeing_domain_chk CHECK (domain IN ('ACADEMIC','SOCIAL','EMOTIONAL','PHYSICAL','SAFETY')),
  CONSTRAINT rpt_wellbeing_avg_chk CHECK (avg_score IS NULL OR (avg_score >= 0 AND avg_score <= 10)),
  CONSTRAINT rpt_wellbeing_response_chk CHECK (response_count >= 0),
  CONSTRAINT rpt_wellbeing_below_chk CHECK (below_threshold_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_wellbeing_domain_trends_uq
  ON rpt_wellbeing_domain_trends (school_id, period, grade_level, domain);

CREATE INDEX IF NOT EXISTS rpt_wellbeing_domain_trends_school_period_idx
  ON rpt_wellbeing_domain_trends (school_id, period DESC);

COMMENT ON TABLE rpt_wellbeing_domain_trends IS
  'Per-(school, period, grade_level, domain) wellbeing aggregate. Written exclusively by WellbeingReadModelWorker consuming svc.wellbeing.response.submitted. PRIVACY KEYSTONE — no individual student attribution. period is the first day of the month. domain is one of ACADEMIC/SOCIAL/EMOTIONAL/PHYSICAL/SAFETY.';

COMMENT ON COLUMN rpt_wellbeing_domain_trends.avg_score IS
  'Average score across all responses in the (school, period, grade_level, domain) bucket. 0.0 to 10.0 scale.';

COMMENT ON COLUMN rpt_wellbeing_domain_trends.below_threshold_count IS
  'Count of responses with avg_score below the wellbeing alert threshold (1 on SCALE_1_5 or 2 on SCALE_1_10). Used by the counsellor dashboard to drive aggregate trend-line alerts without exposing individual responses.';
