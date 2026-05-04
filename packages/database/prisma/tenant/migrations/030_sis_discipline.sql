/* 030_sis_discipline.sql
 * Cycle 9 Step 1 — SIS Discipline schema.
 *
 * Four new tenant base tables for the M20 SIS discipline tables that
 * were deferred from Cycle 1 since they were not needed for the
 * attendance vertical slice. The Step 2 migration adds the M27
 * Behaviour Plans tables (svc_behavior_plans, svc_behavior_plan_goals,
 * svc_bip_teacher_feedback) on top of these.
 *
 *   sis_discipline_categories    Per-school discipline category
 *                                catalogue. severity is a 4-value
 *                                enum CHECK LOW / MEDIUM / HIGH /
 *                                CRITICAL. is_active flags soft
 *                                deactivation. UNIQUE(school_id,
 *                                name).
 *   sis_discipline_action_types  Per-school disciplinary action
 *                                catalogue. requires_parent_notification
 *                                flags actions that fire the parent
 *                                notification path in the Step 4
 *                                ActionService. is_active flags soft
 *                                deactivation. UNIQUE(school_id,
 *                                name).
 *   sis_discipline_incidents     One row per reported incident.
 *                                status is a 3-value enum CHECK OPEN
 *                                / UNDER_REVIEW / RESOLVED with a
 *                                multi-column resolved_chk that keeps
 *                                resolved_by and resolved_at in
 *                                lockstep with the status. Working
 *                                states require both NULL. RESOLVED
 *                                requires both NOT NULL. admin_notes
 *                                is internal and never visible to
 *                                parents per the Step 4 row-scope
 *                                filter.
 *   sis_discipline_actions       Per-incident consequence row.
 *                                UNIQUE(incident_id, action_type_id)
 *                                so admins layer different consequence
 *                                types rather than stacking duplicates
 *                                of the same one. Multi-column
 *                                dates_chk enforces end_date greater
 *                                than or equal to start_date when
 *                                both are set.
 *
 * Soft cross-schema refs per ADR-001 and ADR-020:
 *   sis_discipline_categories.school_id    -> platform.schools(id)
 *   sis_discipline_action_types.school_id  -> platform.schools(id)
 *   sis_discipline_incidents.school_id     -> platform.schools(id)
 *   sis_discipline_incidents.resolved_by   -> hr_employees(id) soft, intra-tenant
 *   sis_discipline_actions.assigned_by     -> hr_employees(id) soft, intra-tenant
 *
 * DB-enforced intra-tenant FKs (5 logical):
 *   sis_discipline_incidents.student_id      -> sis_students(id) CASCADE
 *     When a student is removed from the system the conduct history
 *     goes with them.
 *   sis_discipline_incidents.reported_by     -> hr_employees(id) SET NULL
 *     Audit trail survives a teacher leaving the school. The row
 *     remains for admin review.
 *   sis_discipline_incidents.category_id     -> sis_discipline_categories(id) NO ACTION
 *     Refuses delete of a category with historical incidents. Admin
 *     deactivates via is_active equals false instead.
 *   sis_discipline_actions.incident_id       -> sis_discipline_incidents(id) CASCADE
 *     A consequence has no meaning without its incident.
 *   sis_discipline_actions.action_type_id    -> sis_discipline_action_types(id) NO ACTION
 *     Prevents accidental delete of an action type that has historical
 *     actions referencing it.
 *
 * 0 cross-schema FKs.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header, no semicolons inside any string literal or
 * comment per the splitter trap from Cycles 4 through 8. The splitter
 * cuts on every semicolon regardless of quoting context including
 * inside block comments and inside default expressions.
 */

CREATE TABLE IF NOT EXISTS sis_discipline_categories (
  id            UUID         PRIMARY KEY,
  school_id     UUID         NOT NULL,
  name          TEXT         NOT NULL,
  severity      TEXT         NOT NULL,
  description   TEXT,
  is_active     BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT sis_discipline_categories_severity_chk
    CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'))
);

CREATE UNIQUE INDEX IF NOT EXISTS sis_discipline_categories_school_name_uq
  ON sis_discipline_categories (school_id, name);

CREATE INDEX IF NOT EXISTS sis_discipline_categories_school_active_idx
  ON sis_discipline_categories (school_id, is_active);

COMMENT ON TABLE sis_discipline_categories IS
  'Per-school discipline category catalogue. severity drives the UI pill colour and the Step 4 admin queue sort. Schools layer their own catalogue on top of the seed defaults.';

COMMENT ON COLUMN sis_discipline_categories.severity IS
  'LOW for tardiness or dress code. MEDIUM for disrespect or disruption. HIGH for fighting. CRITICAL for weapons or dangerous items. The Step 4 admin queue tints rows by severity.';

CREATE TABLE IF NOT EXISTS sis_discipline_action_types (
  id                              UUID         PRIMARY KEY,
  school_id                       UUID         NOT NULL,
  name                            TEXT         NOT NULL,
  requires_parent_notification    BOOLEAN      NOT NULL DEFAULT false,
  description                     TEXT,
  is_active                       BOOLEAN      NOT NULL DEFAULT true,
  created_at                      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sis_discipline_action_types_school_name_uq
  ON sis_discipline_action_types (school_id, name);

CREATE INDEX IF NOT EXISTS sis_discipline_action_types_school_active_idx
  ON sis_discipline_action_types (school_id, is_active);

COMMENT ON TABLE sis_discipline_action_types IS
  'Per-school disciplinary action catalogue. The Step 4 ActionService reads requires_parent_notification on every action insert and emits beh.action.parent_notification_required when true so the Step 6 BehaviourNotificationConsumer can fan out IN_APP notifications to portal-enabled guardians.';

COMMENT ON COLUMN sis_discipline_action_types.requires_parent_notification IS
  'When true the Step 4 ActionService emits beh.action.parent_notification_required on assignment. Examples: Detention, In-School Suspension, Out-of-School Suspension. Verbal Warning and Written Warning typically have this false.';

CREATE TABLE IF NOT EXISTS sis_discipline_incidents (
  id              UUID         PRIMARY KEY,
  school_id       UUID         NOT NULL,
  student_id      UUID         NOT NULL REFERENCES sis_students(id) ON DELETE CASCADE,
  reported_by     UUID         REFERENCES hr_employees(id) ON DELETE SET NULL,
  category_id     UUID         NOT NULL REFERENCES sis_discipline_categories(id),
  description     TEXT         NOT NULL,
  incident_date   DATE         NOT NULL,
  incident_time   TIME,
  location        TEXT,
  witnesses       TEXT,
  status          TEXT         NOT NULL DEFAULT 'OPEN',
  resolved_by     UUID,
  resolved_at     TIMESTAMPTZ,
  admin_notes     TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT sis_discipline_incidents_status_chk
    CHECK (status IN ('OPEN', 'UNDER_REVIEW', 'RESOLVED')),
  CONSTRAINT sis_discipline_incidents_resolved_chk
    CHECK (
      (status IN ('OPEN', 'UNDER_REVIEW') AND resolved_by IS NULL AND resolved_at IS NULL)
      OR
      (status = 'RESOLVED' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS sis_discipline_incidents_student_date_idx
  ON sis_discipline_incidents (student_id, incident_date DESC);

CREATE INDEX IF NOT EXISTS sis_discipline_incidents_school_active_idx
  ON sis_discipline_incidents (school_id, status)
  WHERE status <> 'RESOLVED';

COMMENT ON TABLE sis_discipline_incidents IS
  'One row per reported incident. The Step 4 IncidentService stamps reported_by from actor.employeeId on submission. Admin lifecycle transitions use SELECT FOR UPDATE inside an executeInTenantTransaction per the convention. admin_notes is internal and the Step 4 row-scope filter strips it from the parent payload.';

COMMENT ON COLUMN sis_discipline_incidents.admin_notes IS
  'Internal admin notes. Never visible to parents. The Step 4 IncidentService.rowToDto helper strips this column from the response when the caller is not admin or counsellor.';

COMMENT ON CONSTRAINT sis_discipline_incidents_resolved_chk ON sis_discipline_incidents IS
  'Keeps resolved_by and resolved_at in lockstep with status. Working states OPEN and UNDER_REVIEW require both NULL. RESOLVED requires both NOT NULL.';

CREATE TABLE IF NOT EXISTS sis_discipline_actions (
  id                    UUID         PRIMARY KEY,
  incident_id           UUID         NOT NULL REFERENCES sis_discipline_incidents(id) ON DELETE CASCADE,
  action_type_id        UUID         NOT NULL REFERENCES sis_discipline_action_types(id),
  assigned_by           UUID,
  start_date            DATE,
  end_date              DATE,
  notes                 TEXT,
  parent_notified       BOOLEAN      NOT NULL DEFAULT false,
  parent_notified_at    TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT sis_discipline_actions_dates_chk
    CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS sis_discipline_actions_incident_type_uq
  ON sis_discipline_actions (incident_id, action_type_id);

CREATE INDEX IF NOT EXISTS sis_discipline_actions_incident_idx
  ON sis_discipline_actions (incident_id);

COMMENT ON TABLE sis_discipline_actions IS
  'Per-incident consequence row. The Step 4 ActionService reads sis_discipline_action_types.requires_parent_notification on every insert and fires the parent notification path when true. parent_notified and parent_notified_at are set by the Step 6 BehaviourNotificationConsumer after IN_APP delivery succeeds.';

COMMENT ON COLUMN sis_discipline_actions.start_date IS
  'Optional. Suspensions are multi-day with start_date and end_date both set. Verbal warnings have neither set. The dates_chk allows either side null but rejects end_date earlier than start_date when both are set.';
