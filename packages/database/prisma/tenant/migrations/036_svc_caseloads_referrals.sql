/* 036_svc_caseloads_referrals.sql
 * Cycle 11 Step 1 — Counselling caseloads and referrals schema.
 *
 * Four new tenant base tables for the M27 Student Services counselling
 * caseload assignment system and the teacher-to-counsellor referral
 * pipeline. The Step 2 migration adds sessions, notes, and the MTSS
 * tier system on top. The Step 3 migration adds coordinated care plus
 * mandatory reporting and backfills the Cycle 9 svc_behavior_plans
 * caseload_id soft ref into a real FK to svc_caseloads(id).
 *
 *   svc_caseloads          One row per (counsellor, student) assignment
 *                          for an academic year. Two partial UNIQUE
 *                          keystones. The first pins exactly one
 *                          primary counsellor per (student, year). The
 *                          second pins no duplicate active assignments
 *                          per (counsellor, student, year). primary
 *                          concern is a 7-value enum CHECK ACADEMIC,
 *                          BEHAVIORAL, SOCIAL_EMOTIONAL, ATTENDANCE,
 *                          CRISIS, TRANSITION, GENERAL. status is a
 *                          3-value enum CHECK ACTIVE, CLOSED,
 *                          TRANSFERRED.
 *   svc_referral_types     Per-school referral category catalogue.
 *                          default_priority is a 4-value enum CHECK
 *                          LOW, MEDIUM, HIGH, URGENT. The Step 5
 *                          ReferralService copies default_priority into
 *                          new svc_referrals rows on submit.
 *                          requires_parent_notification flags types
 *                          that fire the parent notification path.
 *                          UNIQUE(school_id, name).
 *   svc_referrals          One row per teacher-to-counsellor referral.
 *                          status is a 7-value enum CHECK SUBMITTED,
 *                          TRIAGED, ACCEPTED, IN_PROGRESS, COMPLETED,
 *                          DECLINED, CANCELLED. priority is a 4-value
 *                          enum CHECK LOW, MEDIUM, HIGH, URGENT.
 *                          assigned_counselor_id is nullable so a
 *                          freshly submitted referral sits unassigned
 *                          in the triage queue until a counsellor is
 *                          chosen. The Step 5 service writes a
 *                          svc_referral_activity row on every status
 *                          transition.
 *   svc_referral_activity  IMMUTABLE per ADR-010. Service-side
 *                          discipline. The Step 5
 *                          ReferralActivityService.recordActivity
 *                          helper is the only writer. No UPDATE
 *                          method. No DELETE method. activity_type is
 *                          a 6-value enum CHECK STATUS_CHANGE,
 *                          ASSIGNMENT_CHANGE, NOTE_ADDED,
 *                          PARENT_NOTIFIED, ESCALATED,
 *                          EXTERNAL_CONTACT_MADE. CASCADE on parent
 *                          referral so an emergency hard-delete of a
 *                          referral takes the audit with it. This
 *                          mirrors Cycle 8 tkt_ticket_activity and
 *                          Cycle 10 hlth_health_access_log.
 *
 * Soft cross-schema refs per ADR-001 and ADR-020:
 *   svc_caseloads.school_id          -> platform.schools(id)
 *   svc_referral_types.school_id     -> platform.schools(id)
 *   svc_referrals.school_id          -> platform.schools(id)
 *   svc_referral_activity.actor_id   -> platform.platform_users(id) soft
 *
 * DB-enforced intra-tenant FKs (8 logical):
 *   svc_caseloads.counselor_id          -> hr_employees(id) NO ACTION
 *     Refuses delete of a counsellor with active caseloads. Admin
 *     must close the caseloads first.
 *   svc_caseloads.student_id            -> sis_students(id) CASCADE
 *     Consistent with all other student-referencing tables. When a
 *     student is removed from the system the caseload assignment goes
 *     with them.
 *   svc_caseloads.academic_year_id      -> sis_academic_years(id) NO ACTION
 *     Refuses delete of an academic year with caseloads.
 *   svc_referrals.student_id            -> sis_students(id) CASCADE
 *     Consistent with the student-referencing table convention.
 *   svc_referrals.referred_by           -> hr_employees(id) NO ACTION
 *     The referral has audit value beyond the teacher tenure. Admin
 *     must archive the referral row before the employee row is
 *     removed. NOT NULL per the plan.
 *   svc_referrals.referral_type_id      -> svc_referral_types(id) NO ACTION
 *     Refuses delete of a referral type with historical referrals.
 *     Admin deactivates via is_active equals false instead.
 *   svc_referrals.assigned_counselor_id -> hr_employees(id) SET NULL
 *     If the assigned counsellor leaves the school the referral falls
 *     back to unassigned for re-triage. Nullable column.
 *   svc_referral_activity.referral_id   -> svc_referrals(id) CASCADE
 *     Audit only matters as long as the source row exists. Mirrors
 *     Cycle 8 tkt_ticket_activity.
 *
 * 0 cross-schema FKs.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header. No semicolons inside any string literal or
 * comment per the splitter trap from Cycles 4 through 10. The splitter
 * cuts on every semicolon regardless of quoting context including
 * inside block comments and inside default expressions.
 */

CREATE TABLE IF NOT EXISTS svc_caseloads (
  id                      UUID         PRIMARY KEY,
  school_id               UUID         NOT NULL,
  counselor_id            UUID         NOT NULL REFERENCES hr_employees(id),
  student_id              UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  academic_year_id        UUID         NOT NULL REFERENCES sis_academic_years(id),
  primary_concern         TEXT         NOT NULL,
  is_primary_counselor    BOOLEAN      NOT NULL DEFAULT true,
  status                  TEXT         NOT NULL DEFAULT 'ACTIVE',
  opened_at               DATE         NOT NULL,
  closed_at               DATE,
  closure_reason          TEXT,
  notes                   TEXT,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_caseloads_concern_chk
    CHECK (primary_concern IN ('ACADEMIC', 'BEHAVIORAL', 'SOCIAL_EMOTIONAL', 'ATTENDANCE', 'CRISIS', 'TRANSITION', 'GENERAL')),
  CONSTRAINT svc_caseloads_status_chk
    CHECK (status IN ('ACTIVE', 'CLOSED', 'TRANSFERRED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS svc_caseloads_primary_active_uq
  ON svc_caseloads (student_id, academic_year_id)
  WHERE status = 'ACTIVE' AND is_primary_counselor = true;

CREATE UNIQUE INDEX IF NOT EXISTS svc_caseloads_active_assignment_uq
  ON svc_caseloads (counselor_id, student_id, academic_year_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS svc_caseloads_counselor_status_idx
  ON svc_caseloads (counselor_id, status);

CREATE INDEX IF NOT EXISTS svc_caseloads_student_year_idx
  ON svc_caseloads (student_id, academic_year_id);

COMMENT ON TABLE svc_caseloads IS
  'One row per (counsellor, student) assignment for an academic year. The Step 5 CaseloadService is the canonical writer. The two partial UNIQUE keystones enforce the invariants. svc_caseloads_primary_active_uq pins exactly one primary counsellor per (student, year). svc_caseloads_active_assignment_uq pins no duplicate active assignments per (counsellor, student, year). The Cycle 9 svc_behavior_plans.caseload_id soft ref will be tightened into a real FK by the Step 3 migration once this table exists.';

COMMENT ON COLUMN svc_caseloads.primary_concern IS
  'ACADEMIC for grade or attendance concerns. BEHAVIORAL for repeated discipline incidents. SOCIAL_EMOTIONAL for peer or emotional regulation. ATTENDANCE for chronic absenteeism. CRISIS for acute mental health. TRANSITION for grade transitions or new student support. GENERAL for unspecified.';

COMMENT ON COLUMN svc_caseloads.is_primary_counselor IS
  'A student may have multiple counsellors (a primary plus consultants for specific concerns). Exactly one is marked is_primary_counselor=true per (student, year) — enforced by the partial UNIQUE keystone svc_caseloads_primary_active_uq. The Step 5 service rejects a second primary at the application layer with a friendly 409 carrying the conflicting caseload id.';

COMMENT ON CONSTRAINT svc_caseloads_status_chk ON svc_caseloads IS
  'ACTIVE for the working caseload. CLOSED for caseloads ended by the counsellor with a closure_reason. TRANSFERRED for handoff to a new counsellor at the same school.';

CREATE TABLE IF NOT EXISTS svc_referral_types (
  id                              UUID         PRIMARY KEY,
  school_id                       UUID         NOT NULL,
  name                            TEXT         NOT NULL,
  description                     TEXT,
  default_priority                TEXT         NOT NULL,
  requires_parent_notification    BOOLEAN      NOT NULL DEFAULT false,
  is_active                       BOOLEAN      NOT NULL DEFAULT true,
  created_at                      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_referral_types_priority_chk
    CHECK (default_priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT'))
);

CREATE UNIQUE INDEX IF NOT EXISTS svc_referral_types_school_name_uq
  ON svc_referral_types (school_id, name);

CREATE INDEX IF NOT EXISTS svc_referral_types_school_active_idx
  ON svc_referral_types (school_id, is_active);

COMMENT ON TABLE svc_referral_types IS
  'Per-school referral category catalogue. The Step 5 ReferralService reads default_priority on every referral submit and copies it into the new svc_referrals row (the submitter may override on the form). Schools layer their own catalogue on top of the seeded defaults Social/Emotional and Academic Concern.';

COMMENT ON COLUMN svc_referral_types.requires_parent_notification IS
  'When true the Step 5 ReferralService fires the parent notification path on referral submit. Examples Social/Emotional, Crisis, and Behavioural concerns. Academic Concern typically has this false because it is handled through routine teacher-parent communication.';

CREATE TABLE IF NOT EXISTS svc_referrals (
  id                        UUID         PRIMARY KEY,
  school_id                 UUID         NOT NULL,
  student_id                UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  referred_by               UUID         NOT NULL REFERENCES hr_employees(id),
  referral_type_id          UUID         NOT NULL REFERENCES svc_referral_types(id),
  assigned_counselor_id     UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  priority                  TEXT         NOT NULL,
  status                    TEXT         NOT NULL DEFAULT 'SUBMITTED',
  reason                    TEXT         NOT NULL,
  parent_notified           BOOLEAN      NOT NULL DEFAULT false,
  parent_notified_at        TIMESTAMPTZ,
  outcome                   TEXT,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_referrals_priority_chk
    CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
  CONSTRAINT svc_referrals_status_chk
    CHECK (status IN ('SUBMITTED', 'TRIAGED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'CANCELLED'))
);

CREATE INDEX IF NOT EXISTS svc_referrals_school_status_idx
  ON svc_referrals (school_id, status);

CREATE INDEX IF NOT EXISTS svc_referrals_assigned_status_idx
  ON svc_referrals (assigned_counselor_id, status);

CREATE INDEX IF NOT EXISTS svc_referrals_student_idx
  ON svc_referrals (student_id);

CREATE INDEX IF NOT EXISTS svc_referrals_referred_by_status_idx
  ON svc_referrals (referred_by, status);

COMMENT ON TABLE svc_referrals IS
  'One row per teacher-to-counsellor referral. The Step 5 ReferralService stamps referred_by from actor.employeeId on submit and copies default_priority from the chosen referral_type. assigned_counselor_id is null on submit (the row sits in the school admin triage queue) and is populated during triage. status transitions use SELECT FOR UPDATE inside an executeInTenantTransaction per the convention. Each transition writes a svc_referral_activity row.';

COMMENT ON COLUMN svc_referrals.assigned_counselor_id IS
  'Null on submit so the referral sits unassigned in the triage queue. Set during the Step 5 triage transition (SUBMITTED to TRIAGED). If the assigned counsellor leaves the school the FK SET NULL action returns the referral to the unassigned state for re-triage.';

COMMENT ON COLUMN svc_referrals.outcome IS
  'Free-form summary recorded on the COMPLETED transition. Captures whether a caseload was opened, an external referral was made, or no further action was needed. Visible to the original submitter so the teacher learns the outcome of their referral.';

CREATE TABLE IF NOT EXISTS svc_referral_activity (
  id              UUID         PRIMARY KEY,
  referral_id     UUID         NOT NULL REFERENCES svc_referrals(id) ON DELETE CASCADE,
  actor_id        UUID         NOT NULL,
  activity_type   TEXT         NOT NULL,
  notes           TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT svc_referral_activity_type_chk
    CHECK (activity_type IN ('STATUS_CHANGE', 'ASSIGNMENT_CHANGE', 'NOTE_ADDED', 'PARENT_NOTIFIED', 'ESCALATED', 'EXTERNAL_CONTACT_MADE'))
);

CREATE INDEX IF NOT EXISTS svc_referral_activity_referral_time_idx
  ON svc_referral_activity (referral_id, created_at ASC);

COMMENT ON TABLE svc_referral_activity IS
  'IMMUTABLE per ADR-010. Service-side discipline. No UPDATE. No DELETE. The Step 5 ReferralActivityService.recordActivity is the only writer and is called by every ReferralService status mutation. CASCADE on parent referral so an emergency hard-delete takes the audit with it. The 6-value activity_type enum covers every audit shape. STATUS_CHANGE for lifecycle transitions. ASSIGNMENT_CHANGE for triage assignment. NOTE_ADDED for free-form review notes. PARENT_NOTIFIED when the parent notification path fires. ESCALATED for crisis escalation. EXTERNAL_CONTACT_MADE for referral to outside services.';

COMMENT ON COLUMN svc_referral_activity.actor_id IS
  'Soft to platform.platform_users(id) per ADR-001. Captures the actor account id stamped from actor.accountId. The Step 5 service-layer write path never trusts caller input for this column.';
