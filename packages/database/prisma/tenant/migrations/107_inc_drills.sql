/*
  Phase 2 Cycle 2 (P2C2) Step 3 - M91 Incident & Emergency, drills
  and non-discipline incidents.

  2 logical base tables completing the cycle:

  - inc_drills practice runs of an incident response. Drill rows
    reference inc_incident_types so a school chooses LOCKDOWN or
    FIRE_DRILL etc. from its catalogue. Lifecycle status SCHEDULED
    -> COMPLETED (or CANCELLED). participation_rate NUMERIC(5,4)
    captures fraction of expected participants that mustered
    correctly (0.9876 = 98.76 percent). Multi-column
    inc_drills_completed_chk keeps duration_seconds and
    participation_rate populated only on COMPLETED rows. Partial
    INDEX(school_id, scheduled_at) WHERE status='COMPLETED'
    backs the "overdue drill" sweep that flags schools with no
    completed drill of a required type in the last 90 days.

  - inc_non_discipline_incidents day-to-day safety reporting:
    student injury, medical episode, property damage, etc. 7-value
    incident_type CHECK (STUDENT_INJURY, STAFF_INJURY,
    MEDICAL_EPISODE, PROPERTY_DAMAGE, ENVIRONMENTAL, SECURITY,
    OTHER). 3-value severity CHECK (LOW, MEDIUM, HIGH). 3-state
    status (OPEN, UNDER_REVIEW, CLOSED). students_involved and
    staff_involved are UUID[] soft refs to sis_students(id) and
    hr_employees(id) - no DB FK because dependent-array FKs are
    not natively supported. follow_up_ticket_id is a soft ref to
    Cycle 8 tkt_tickets(id) for nurse / facilities / counsellor
    follow-up. Partial INDEX(school_id, status) for the open-queue
    hot path.

  Splitter notes: provision-tenant.ts splits on every literal
  semicolon and filters chunks that begin with a line comment.
  No semicolons appear inside any string literal or block comment
  here, and no chunk between CREATE / ALTER / COMMENT statements
  starts with a line comment.

  Cycle total: 11 base tables (4 + 5 + 2). All FKs intra-tenant.
  reported_by is a soft ref to platform.platform_users(id) per
  ADR-001 / ADR-020 - the Step 7 NonDisciplineIncidentService
  validates the actor's account_id projection at the application
  layer.
*/

CREATE TABLE IF NOT EXISTS inc_drills (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  incident_type_id UUID,
  procedure_type TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  duration_seconds INT,
  participation_rate NUMERIC(5, 4),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'SCHEDULED',
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inc_drills_status_chk
    CHECK (status IN ('SCHEDULED', 'COMPLETED', 'CANCELLED')),
  CONSTRAINT inc_drills_proc_type_chk
    CHECK (procedure_type IN (
      'FIRE_EVACUATION', 'LOCKDOWN', 'SHELTER_IN_PLACE', 'MEDICAL_EMERGENCY',
      'BOMB_THREAT', 'HAZMAT', 'MISSING_STUDENT', 'SAFEGUARDING_CRISIS', 'GENERAL'
    )),
  CONSTRAINT inc_drills_completed_chk
    CHECK (
      (status = 'SCHEDULED' AND completed_at IS NULL AND duration_seconds IS NULL AND participation_rate IS NULL)
      OR
      (status = 'CANCELLED' AND completed_at IS NULL)
      OR
      (status = 'COMPLETED' AND completed_at IS NOT NULL AND duration_seconds IS NOT NULL AND participation_rate IS NOT NULL)
    ),
  CONSTRAINT inc_drills_duration_chk
    CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  CONSTRAINT inc_drills_rate_chk
    CHECK (participation_rate IS NULL OR (participation_rate >= 0 AND participation_rate <= 1)),
  CONSTRAINT inc_drills_type_fk
    FOREIGN KEY (incident_type_id) REFERENCES inc_incident_types(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS inc_drills_school_completed_idx
  ON inc_drills (school_id, scheduled_at) WHERE status = 'COMPLETED';

CREATE INDEX IF NOT EXISTS inc_drills_school_scheduled_idx
  ON inc_drills (school_id, scheduled_at) WHERE status = 'SCHEDULED';

COMMENT ON TABLE inc_drills IS
  'Practice runs of emergency procedures. Overdue sweep query: schools with no COMPLETED drill of a required procedure_type in the last 90 days.';

CREATE TABLE IF NOT EXISTS inc_non_discipline_incidents (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  incident_type TEXT NOT NULL,
  location TEXT,
  incident_date TIMESTAMPTZ NOT NULL,
  description TEXT NOT NULL,
  students_involved UUID[],
  staff_involved UUID[],
  witnesses TEXT,
  reported_by UUID NOT NULL,
  severity TEXT NOT NULL DEFAULT 'LOW',
  follow_up_ticket_id UUID,
  resolution TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inc_nondisc_type_chk
    CHECK (incident_type IN (
      'STUDENT_INJURY', 'STAFF_INJURY', 'MEDICAL_EPISODE',
      'PROPERTY_DAMAGE', 'ENVIRONMENTAL', 'SECURITY', 'OTHER'
    )),
  CONSTRAINT inc_nondisc_severity_chk
    CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
  CONSTRAINT inc_nondisc_status_chk
    CHECK (status IN ('OPEN', 'UNDER_REVIEW', 'CLOSED')),
  CONSTRAINT inc_nondisc_closed_chk
    CHECK (
      (status IN ('OPEN', 'UNDER_REVIEW') AND closed_at IS NULL)
      OR
      (status = 'CLOSED' AND closed_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS inc_nondisc_school_status_idx
  ON inc_non_discipline_incidents (school_id, status);

CREATE INDEX IF NOT EXISTS inc_nondisc_school_date_idx
  ON inc_non_discipline_incidents (school_id, incident_date DESC);

CREATE INDEX IF NOT EXISTS inc_nondisc_reporter_idx
  ON inc_non_discipline_incidents (reported_by, incident_date DESC);

COMMENT ON TABLE inc_non_discipline_incidents IS
  'Day-to-day safety reporting that does not rise to emergency level. follow_up_ticket_id is a soft ref to Cycle 8 tkt_tickets so the nurse / facilities team can track corrective action. Emits inc.incident.reported on insert.';
