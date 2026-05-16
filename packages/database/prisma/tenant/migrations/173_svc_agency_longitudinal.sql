/* 173_svc_agency_longitudinal.sql
 *
 * Phase 2 Cycle 28 sub-cycle c (P2-28c) — Student Services Advanced.
 *
 * 2 new tenant tables plus additive columns on the Cycle 11 svc
 * surface to bring it up to the P2-28c plan shape. Together with
 * the existing Cycle 11 svc_caseloads, svc_referral_types, svc
 * _referrals, svc_referral_activity and the Cycle 11 svc_mtss
 * _team_meetings + svc_mtss_team_meeting_students this completes
 * the 8 tables the P2-28c plan headers call out.
 *
 * Note on the plan vs reality: the P2-28c plan headers list 8
 * tables. Six of those already shipped in Cycle 11 migrations 036
 * + 037 together with the matching CaseloadService + Referral
 * Service + ReferralActivityService — including the IMMUTABLE
 * KEYSTONE on svc_referral_activity (no UPDATE method, no DELETE
 * method, CASCADE on parent referral so an emergency hard-delete
 * takes the audit with it — mirrors Cycle 8 tkt_ticket_activity
 * and Cycle 10 hlth_health_access_log). P2-28c only ships the 2
 * truly-new tables here plus the additive columns the plan calls
 * for on existing tables. The plan over-counts the same way
 * P2-26, P2-27, and P2-28b did. The referral immutability
 * contract is already enforced at the schema layer and at the
 * Cycle 11 ReferralActivityService request path.
 *
 *   svc_agency_referrals          External agency referral row
 *                                 attached to a parent svc_referrals.
 *                                 4-value status CHECK REFERRED /
 *                                 CONTACTED / ACTIVE_SERVICE /
 *                                 DISCHARGED. consent_obtained
 *                                 BOOLEAN default false — schools
 *                                 cannot release student information
 *                                 to an outside agency without
 *                                 parent consent. follow_up_date
 *                                 DATE for the next check-in.
 *                                 INDEX(referral_id) for the
 *                                 reverse-lookup path.
 *
 *   svc_wellbeing_longitudinal    Per-(student, academic_year,
 *                                 domain) longitudinal aggregate.
 *                                 5-value domain CHECK ACADEMIC /
 *                                 SOCIAL / EMOTIONAL / PHYSICAL /
 *                                 SAFETY. 3-value trend CHECK
 *                                 IMPROVING / STABLE / DECLINING.
 *                                 UNIQUE(student_id, academic
 *                                 _year, domain). Materialised
 *                                 annually from svc_wellbeing
 *                                 _responses by the Step 6
 *                                 WellbeingLongitudinalService —
 *                                 NO individual check-in data,
 *                                 only aggregated domain scores
 *                                 and trend per academic year.
 *                                 avg_score NUMERIC(3,1) clamped
 *                                 to [0, 10]. checkin_count and
 *                                 flagged_count non-negative.
 *
 * Additive columns on the Cycle 11 svc surface to match the
 * P2-28c plan:
 *
 *   svc_referral_types
 *     ADD COLUMN referral_category TEXT       — 3-value CHECK
 *       INTERNAL / EXTERNAL / CRISIS. Nullable for backwards
 *       compatibility with the Cycle 11 seed (existing rows
 *       coerce to INTERNAL via the Step 6 service on first
 *       read).
 *
 *   svc_referrals
 *     ADD COLUMN concern_description TEXT     — long-form concern
 *       captured at submission. Nullable so the Cycle 11 seed
 *       which used the legacy reason column continues to work.
 *     ADD COLUMN source_incident_id  UUID     — SOFT INTEGRITY
 *       ref to sis_discipline_incidents per ADR-001 / ADR-020.
 *       NULL when the referral was not initiated from a
 *       discipline event.
 *
 * Soft cross-schema refs per ADR-001 and ADR-020:
 *   svc_agency_referrals.referral_id        -> svc_referrals(id)
 *     DB-enforced intra-tenant FK CASCADE — agency rows are
 *     meaningless without their parent referral.
 *   svc_wellbeing_longitudinal.student_id   -> sis_students(id)
 *     DB-enforced intra-tenant FK CASCADE — longitudinal rows
 *     follow the student.
 *   svc_wellbeing_longitudinal.school_id    -> platform.schools(id)
 *     SOFT integrity per the tenant convention.
 *
 * DB-enforced intra-tenant FKs (2 new):
 *   svc_agency_referrals.referral_id        -> svc_referrals(id) CASCADE
 *   svc_wellbeing_longitudinal.student_id   -> sis_students(id) CASCADE
 *
 * 0 cross-schema FKs.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * ALTER TABLE ADD COLUMN IF NOT EXISTS for additive columns. Block
 * comment header. No semicolons inside any string literal or
 * comment per the splitter trap from Cycles 4 onwards. The splitter
 * cuts on every semicolon regardless of quoting context including
 * inside block comments and inside default expressions.
 */

CREATE TABLE IF NOT EXISTS svc_agency_referrals (
  id                  UUID         PRIMARY KEY,
  referral_id         UUID         NOT NULL REFERENCES svc_referrals(id) ON DELETE CASCADE,
  agency_name         TEXT         NOT NULL,
  agency_contact      TEXT,
  agency_phone        TEXT,
  agency_email        TEXT,
  referral_date       DATE         NOT NULL,
  reason              TEXT         NOT NULL,
  status              TEXT         NOT NULL DEFAULT 'REFERRED',
  consent_obtained    BOOLEAN      NOT NULL DEFAULT false,
  follow_up_date      DATE,
  notes               TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_agency_referrals_status_chk
    CHECK (status IN ('REFERRED', 'CONTACTED', 'ACTIVE_SERVICE', 'DISCHARGED'))
);

CREATE INDEX IF NOT EXISTS svc_agency_referrals_referral_idx
  ON svc_agency_referrals (referral_id);

CREATE INDEX IF NOT EXISTS svc_agency_referrals_status_idx
  ON svc_agency_referrals (status);

COMMENT ON TABLE svc_agency_referrals IS
  'External agency referral attached to svc_referrals — REFERRED, CONTACTED, ACTIVE_SERVICE, DISCHARGED with consent gate.';

COMMENT ON COLUMN svc_agency_referrals.consent_obtained IS
  'Parent consent before agency referral release. Schools cannot share student information with outside agencies without this flag set true.';

CREATE TABLE IF NOT EXISTS svc_wellbeing_longitudinal (
  id                  UUID         PRIMARY KEY,
  student_id          UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  school_id           UUID         NOT NULL,
  academic_year       TEXT         NOT NULL,
  domain              TEXT         NOT NULL,
  avg_score           NUMERIC(3,1),
  trend               TEXT         NOT NULL DEFAULT 'STABLE',
  checkin_count       INT          NOT NULL DEFAULT 0,
  flagged_count       INT          NOT NULL DEFAULT 0,
  counsellor_notes    TEXT,
  materialised_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_wellbeing_long_domain_chk
    CHECK (domain IN ('ACADEMIC', 'SOCIAL', 'EMOTIONAL', 'PHYSICAL', 'SAFETY')),
  CONSTRAINT svc_wellbeing_long_trend_chk
    CHECK (trend IN ('IMPROVING', 'STABLE', 'DECLINING')),
  CONSTRAINT svc_wellbeing_long_score_range_chk
    CHECK (avg_score IS NULL OR (avg_score >= 0 AND avg_score <= 10)),
  CONSTRAINT svc_wellbeing_long_checkin_count_chk
    CHECK (checkin_count >= 0),
  CONSTRAINT svc_wellbeing_long_flagged_count_chk
    CHECK (flagged_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS svc_wellbeing_long_student_year_domain_uq
  ON svc_wellbeing_longitudinal (student_id, academic_year, domain);

CREATE INDEX IF NOT EXISTS svc_wellbeing_long_school_year_idx
  ON svc_wellbeing_longitudinal (school_id, academic_year);

COMMENT ON TABLE svc_wellbeing_longitudinal IS
  'Annual aggregation of svc_wellbeing_responses per (student, academic_year, domain). No individual check-in data — only aggregated domain scores and trend.';

COMMENT ON COLUMN svc_wellbeing_longitudinal.materialised_at IS
  'Timestamp of last materialisation run. Service overwrites on re-run.';

ALTER TABLE svc_referral_types
  ADD COLUMN IF NOT EXISTS referral_category TEXT;

ALTER TABLE svc_referral_types
  DROP CONSTRAINT IF EXISTS svc_referral_types_category_chk;

ALTER TABLE svc_referral_types
  ADD CONSTRAINT svc_referral_types_category_chk
    CHECK (referral_category IS NULL OR referral_category IN ('INTERNAL', 'EXTERNAL', 'CRISIS'));

COMMENT ON COLUMN svc_referral_types.referral_category IS
  'Top-level category — INTERNAL (in-school counsellor), EXTERNAL (outside agency), or CRISIS (auto-escalates to admin per P2-28c ReferralService). Nullable for backwards compatibility with Cycle 11 seed rows.';

ALTER TABLE svc_referrals
  ADD COLUMN IF NOT EXISTS concern_description TEXT;

ALTER TABLE svc_referrals
  ADD COLUMN IF NOT EXISTS source_incident_id UUID;

COMMENT ON COLUMN svc_referrals.concern_description IS
  'Long-form concern at submission. Nullable so Cycle 11 seed rows using the legacy reason column keep working.';

COMMENT ON COLUMN svc_referrals.source_incident_id IS
  'Soft FK to sis_discipline_incidents(id) per ADR-001 and ADR-020. NULL when the referral was not initiated from a discipline event.';

CREATE INDEX IF NOT EXISTS svc_referrals_source_incident_idx
  ON svc_referrals (source_incident_id)
  WHERE source_incident_id IS NOT NULL;
