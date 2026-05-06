/*
 * 058_ext_activities.sql — Cycle 17 Step 1.
 *
 * M64 Clubs and Student Life domain 1: activity types catalogue and
 * activities with membership rosters and recurring schedules. The new
 * ext_ prefix is greenfield for this cycle. Soft FKs to platform are
 * UUID columns only per ADR-001 / ADR-020. Intra-tenant FKs are
 * DB-enforced.
 *
 * No semicolons inside string literals or block comments — the tenant
 * provisioner splits on the semicolon character regardless of context.
 */

CREATE TABLE IF NOT EXISTS ext_activity_types (
  id            UUID PRIMARY KEY,
  school_id     UUID NOT NULL,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,
  description   TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ext_activity_types_category_chk CHECK (
    category IN ('SPORT', 'ARTS', 'ACADEMIC', 'LEADERSHIP', 'COMMUNITY', 'OTHER')
  ),
  CONSTRAINT ext_activity_types_school_name_uq UNIQUE (school_id, name)
);

COMMENT ON TABLE ext_activity_types IS
  'Per-school catalogue of club / activity types. Category drives the Step 8 filter chips. Soft FK on school_id to platform.schools.';

CREATE TABLE IF NOT EXISTS ext_activities (
  id                  UUID PRIMARY KEY,
  school_id           UUID NOT NULL,
  activity_type_id    UUID NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT,
  academic_year_id    UUID NOT NULL,
  advisor_id          UUID,
  max_participants    INT,
  status              TEXT NOT NULL DEFAULT 'ACTIVE',
  meeting_location    TEXT,
  group_id            UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ext_activities_status_chk CHECK (status IN ('ACTIVE', 'INACTIVE', 'COMPLETED')),
  CONSTRAINT ext_activities_max_chk CHECK (max_participants IS NULL OR max_participants > 0),
  CONSTRAINT ext_activities_type_fk FOREIGN KEY (activity_type_id)
    REFERENCES ext_activity_types(id) ON DELETE NO ACTION,
  CONSTRAINT ext_activities_year_fk FOREIGN KEY (academic_year_id)
    REFERENCES sis_academic_years(id) ON DELETE NO ACTION,
  CONSTRAINT ext_activities_advisor_fk FOREIGN KEY (advisor_id)
    REFERENCES hr_employees(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS ext_activities_school_year_status_idx
  ON ext_activities (school_id, academic_year_id, status);

COMMENT ON TABLE ext_activities IS
  'Club / activity definition. activity_type_id and academic_year_id are NO ACTION because admin must reassign or deactivate before delete. advisor_id is SET NULL so the row survives a staff departure. group_id is a soft FK to grp_groups for future M103 Groups integration.';

CREATE TABLE IF NOT EXISTS ext_activity_members (
  id            UUID PRIMARY KEY,
  activity_id   UUID NOT NULL,
  student_id    UUID NOT NULL,
  role          TEXT NOT NULL DEFAULT 'MEMBER',
  joined_at     DATE NOT NULL,
  left_at       DATE,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ext_activity_members_role_chk CHECK (role IN ('MEMBER', 'OFFICER', 'PRESIDENT', 'SECRETARY')),
  CONSTRAINT ext_activity_members_dates_chk CHECK (left_at IS NULL OR left_at >= joined_at),
  CONSTRAINT ext_activity_members_activity_fk FOREIGN KEY (activity_id)
    REFERENCES ext_activities(id) ON DELETE CASCADE,
  CONSTRAINT ext_activity_members_student_fk FOREIGN KEY (student_id)
    REFERENCES sis_students(id) ON DELETE CASCADE,
  CONSTRAINT ext_activity_members_unique_uq UNIQUE (activity_id, student_id)
);

CREATE INDEX IF NOT EXISTS ext_activity_members_student_active_idx
  ON ext_activity_members (student_id, is_active);

COMMENT ON TABLE ext_activity_members IS
  'Membership rosters with role tracking. CASCADE on both parents because membership is meaningless without its activity and is personal student data.';

CREATE TABLE IF NOT EXISTS ext_activity_schedules (
  id            UUID PRIMARY KEY,
  activity_id   UUID NOT NULL,
  day_of_week   SMALLINT NOT NULL,
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  location      TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ext_activity_schedules_dow_chk CHECK (day_of_week BETWEEN 0 AND 6),
  CONSTRAINT ext_activity_schedules_time_chk CHECK (start_time < end_time),
  CONSTRAINT ext_activity_schedules_activity_fk FOREIGN KEY (activity_id)
    REFERENCES ext_activities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ext_activity_schedules_activity_active_idx
  ON ext_activity_schedules (activity_id, is_active);

COMMENT ON TABLE ext_activity_schedules IS
  'Recurring schedule entries. day_of_week 0..6 ISO weekday. start_time and end_time enforce start before end. CASCADE on activity since a schedule has no meaning without its activity.';
