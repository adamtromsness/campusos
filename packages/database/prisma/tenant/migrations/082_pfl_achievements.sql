/* ============================================================
 * Cycle 24 — Step 2: Achievements + Achievement Shares (Tenant)
 * ============================================================
 *
 * Cross-module achievements aggregating from every prior cycle,
 * and achievement sharing to external platforms.
 *
 * Step 2 lands 2 logical base tables, completing the M26
 * Portfolio schema phase:
 *
 *   - pfl_achievements — one row per (student, achievement).
 *     6-value achievement_type CHECK ACADEMIC/SPORTING/MUSICAL/
 *     LEADERSHIP/COMMUNITY/CUSTOM. source_module + source_ref_id
 *     are DISPLAY-ONLY polymorphic refs per ADR-001/020 — they
 *     can point at lib_programme_completions, ath_all_time_records,
 *     ext_service_progress, or any other prior-cycle source.
 *     awarded_by is a DB-enforced FK on hr_employees with SET NULL
 *     so the achievement survives a teacher leaving the school
 *     (matches the audit-trail convention from Cycles 1-9).
 *
 *   - pfl_achievement_shares — one row per share event. 3-value
 *     platform CHECK EMAIL/SOCIAL/PORTFOLIO. CASCADE on parent
 *     achievement so deleting an achievement also wipes its
 *     share history.
 *
 * 2 new intra-tenant DB-enforced FKs (1 SET NULL on
 * achievements.awarded_by, 1 CASCADE on shares.achievement_id).
 * 0 cross-schema DB-enforced FKs — every cross-module ref is
 * soft per ADR-001/020.
 *
 * Splitter-safe — no semicolons inside string literals or block
 * comments. Idempotent — re-runs are a no-op.
 * ============================================================ */

CREATE TABLE IF NOT EXISTS pfl_achievements (
  id                 UUID PRIMARY KEY,
  student_id         UUID NOT NULL,
  school_id          UUID NOT NULL,
  title              TEXT NOT NULL,
  achievement_type   TEXT NOT NULL,
  source_module      TEXT,
  source_ref_id      UUID,
  awarded_at         DATE NOT NULL,
  awarded_by         UUID,
  description        TEXT,
  badge_image_url    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pfl_achievement_type_chk CHECK (
    achievement_type IN ('ACADEMIC', 'SPORTING', 'MUSICAL', 'LEADERSHIP', 'COMMUNITY', 'CUSTOM')
  ),
  CONSTRAINT pfl_achievement_awarded_by_fk FOREIGN KEY (awarded_by)
    REFERENCES hr_employees(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS pfl_achievement_student_idx
  ON pfl_achievements (student_id, school_id);

CREATE INDEX IF NOT EXISTS pfl_achievement_source_idx
  ON pfl_achievements (source_module, source_ref_id)
  WHERE source_module IS NOT NULL;

COMMENT ON TABLE pfl_achievements IS
  'Cycle 24 — cross-module achievements. SET NULL on awarded_by so the achievement survives a teacher leaving the school. source_module + source_ref_id are DISPLAY-ONLY polymorphic refs per ADR-001/020 — they can point at lib_programme_completions, ath_all_time_records, ext_service_progress, or any other prior-cycle source.';

COMMENT ON COLUMN pfl_achievements.student_id IS
  'Soft FK to platform.platform_students(id) per ADR-001/020. Validated at the application layer.';

COMMENT ON COLUMN pfl_achievements.source_module IS
  'DISPLAY-ONLY pointer to the originating module — library, athletics, clubs, classroom, manual, etc. Null for teacher-awarded custom achievements with no source.';

COMMENT ON COLUMN pfl_achievements.source_ref_id IS
  'DISPLAY-ONLY polymorphic UUID per ADR-001/020. Interpreted via source_module. library -> lib_programme_completions(id). athletics -> ath_all_time_records(id). clubs -> ext_service_progress(id). Application-layer resolution at read time. Achievements are intentionally portable and independent of source module.';

CREATE TABLE IF NOT EXISTS pfl_achievement_shares (
  id              UUID PRIMARY KEY,
  achievement_id  UUID NOT NULL,
  shared_by       UUID NOT NULL,
  platform        TEXT NOT NULL,
  shared_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pfl_achievement_share_platform_chk CHECK (
    platform IN ('EMAIL', 'SOCIAL', 'PORTFOLIO')
  ),
  CONSTRAINT pfl_achievement_share_fk FOREIGN KEY (achievement_id)
    REFERENCES pfl_achievements(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS pfl_achievement_share_idx
  ON pfl_achievement_shares (achievement_id, shared_at DESC);

COMMENT ON TABLE pfl_achievement_shares IS
  'Cycle 24 — share events for an achievement. CASCADE on parent so deleting an achievement also wipes its share history. shared_by is a soft FK to platform.platform_users(id) per ADR-001/020 — the student who initiated the share.';

COMMENT ON COLUMN pfl_achievement_shares.shared_by IS
  'Soft FK to platform.platform_users(id) per ADR-001/020. Validated at the application layer. The student who shared the achievement.';

COMMENT ON COLUMN pfl_achievement_shares.platform IS
  '3-value CHECK EMAIL/SOCIAL/PORTFOLIO. EMAIL: shared via the email service. SOCIAL: shared to an external social platform. PORTFOLIO: pinned to a portfolio item.';
