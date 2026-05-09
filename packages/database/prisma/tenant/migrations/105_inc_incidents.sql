/*
  Phase 2 Cycle 2 (P2C2) Step 1 - M91 Incident & Emergency, foundational layer.

  4 logical base tables:

  - inc_incident_types per-school catalogue plus 3 platform defaults.
    COALESCE-sentinel UNIQUE on (school_id, code) keyed on
    '00000000-0000-0000-0000-000000000000' so platform defaults
    (school_id IS NULL) and per-school overrides coexist on the same
    code.

  - inc_incidents declared emergencies (one row per declaration).
    Multi-column inc_incidents_resolved_chk keeps status in lockstep
    with resolved_at and resolved_by - ACTIVE means both NULL,
    RESOLVED or CANCELLED means both NOT NULL. Partial INDEX
    on (school_id, status) WHERE status='ACTIVE' is the hot path
    for the emergency dashboard "is anything active" query.

  - inc_emergency_procedures per-school plus per-procedure_type
    response plan (9 procedure types per the function library).
    procedure_steps JSONB is an ordered array of step objects with
    step_number, action, responsible_role, time_target_seconds.
    Surfaced during active incidents on the responder dashboard.
    inc_proc_school_type_uq keyed on (school_id, procedure_type)
    WHERE is_active=true so an inactive procedure can be retired
    while a fresh active one ships under the same type.

  - inc_declaration_outbox ATOMIC ORCHESTRATION KEYSTONE. Created
    in the same tenant tx as inc_incidents (UNIQUE on incident_id
    enforces one outbox row per incident). Each nullable TIMESTAMPTZ
    column represents one fan-out step: tasks_created_at,
    muster_taken_at, alert_sent_at. The Step 5 DeclarationOutboxWorker
    queries the partial INDEX inc_outbox_pending_idx (rows where any
    step is unstamped) and stamps each column on success. A NULL
    column more than 5 minutes after declared_at triggers PAGE alert.
    last_attempt_at + attempt_count + last_error capture transient
    failures so the worker is crash-recoverable: on restart it picks
    up from the last unstamped step. Adding a new fan-out step is a
    single ALTER TABLE ADD COLUMN nullable - zero impact on existing
    code.

  Splitter notes: provision-tenant.ts splits on every literal
  semicolon and filters chunks that begin with a line comment.
  No semicolons appear inside any string literal or block comment
  here, and no chunk between CREATE / ALTER / COMMENT statements
  starts with a line comment.

  Cross-cycle integration (called by Step 5 DeclarationOutboxWorker):
  - tasks_created_at -> tsk_tasks (Cycle 7) inserts URGENT auto-tasks
    for procedure responders.
  - muster_taken_at -> vis_emergency_muster (P2C1) snapshot of every
    visitor currently signed in plus inc_accountability_records bulk
    insert from sis_enrollments and hr_employees rosters.
  - alert_sent_at -> Cycle 14 EmergencyAlertService.issue using the
    incident_type_id notification_template, with incident_id
    populated on the alert row.

  All FKs in this migration are intra-tenant. declared_by, resolved_by,
  primary_contact_id, secondary_contact_id, reviewed_by are soft
  refs to platform.platform_users(id) per ADR-001 / ADR-020 - the
  request services validate via the actor's account_id projection.
*/

CREATE TABLE IF NOT EXISTS inc_incident_types (
  id UUID PRIMARY KEY,
  school_id UUID,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  severity TEXT NOT NULL,
  requires_lockdown BOOLEAN NOT NULL DEFAULT false,
  notification_template TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inc_incident_types_severity_chk
    CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'))
);

CREATE UNIQUE INDEX IF NOT EXISTS inc_incident_types_school_code_uq
  ON inc_incident_types (COALESCE(school_id, '00000000-0000-0000-0000-000000000000'::uuid), code);

CREATE INDEX IF NOT EXISTS inc_incident_types_active_idx
  ON inc_incident_types (school_id, is_active) WHERE is_active = true;

COMMENT ON TABLE inc_incident_types IS
  'Per-school catalogue of incident classifications. Platform defaults use school_id IS NULL via the COALESCE-sentinel UNIQUE.';

CREATE TABLE IF NOT EXISTS inc_incidents (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  incident_type_id UUID,
  declared_by UUID NOT NULL,
  declared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  title TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  resolved_at TIMESTAMPTZ,
  resolved_by UUID,
  resolution_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inc_incidents_status_chk
    CHECK (status IN ('ACTIVE', 'RESOLVED', 'CANCELLED')),
  CONSTRAINT inc_incidents_resolved_chk
    CHECK (
      (status = 'ACTIVE' AND resolved_at IS NULL AND resolved_by IS NULL)
      OR
      (status IN ('RESOLVED', 'CANCELLED') AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
    ),
  CONSTRAINT inc_incidents_type_fk
    FOREIGN KEY (incident_type_id) REFERENCES inc_incident_types(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS inc_incidents_school_active_idx
  ON inc_incidents (school_id, status) WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS inc_incidents_school_declared_idx
  ON inc_incidents (school_id, declared_at DESC);

COMMENT ON TABLE inc_incidents IS
  'Declared emergencies. ACTIVE rows are surfaced in full-screen emergency mode. RESOLVED rows freeze for after-action reporting.';

CREATE TABLE IF NOT EXISTS inc_emergency_procedures (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  procedure_type TEXT NOT NULL,
  title TEXT NOT NULL,
  procedure_steps JSONB NOT NULL,
  primary_contact_id UUID NOT NULL,
  secondary_contact_id UUID,
  external_contacts JSONB,
  assembly_points JSONB,
  last_reviewed_at DATE NOT NULL,
  reviewed_by UUID NOT NULL,
  next_review_date DATE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  procedure_document_s3_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inc_proc_type_chk
    CHECK (procedure_type IN (
      'FIRE_EVACUATION', 'LOCKDOWN', 'SHELTER_IN_PLACE', 'MEDICAL_EMERGENCY',
      'BOMB_THREAT', 'HAZMAT', 'MISSING_STUDENT', 'SAFEGUARDING_CRISIS', 'GENERAL'
    )),
  CONSTRAINT inc_proc_review_chk
    CHECK (next_review_date >= last_reviewed_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS inc_proc_school_type_uq
  ON inc_emergency_procedures (school_id, procedure_type) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS inc_proc_review_due_idx
  ON inc_emergency_procedures (school_id, next_review_date) WHERE is_active = true;

COMMENT ON TABLE inc_emergency_procedures IS
  'Per-school response plan per procedure_type. procedure_steps is an ordered JSONB array. Surfaced during active incidents.';

CREATE TABLE IF NOT EXISTS inc_declaration_outbox (
  id UUID PRIMARY KEY,
  incident_id UUID NOT NULL UNIQUE,
  school_id UUID NOT NULL,
  declared_at TIMESTAMPTZ NOT NULL,
  tasks_created_at TIMESTAMPTZ,
  muster_taken_at TIMESTAMPTZ,
  alert_sent_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  attempt_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inc_outbox_incident_fk
    FOREIGN KEY (incident_id) REFERENCES inc_incidents(id) ON DELETE CASCADE,
  CONSTRAINT inc_outbox_attempt_chk CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS inc_outbox_pending_idx
  ON inc_declaration_outbox (declared_at)
  WHERE tasks_created_at IS NULL OR muster_taken_at IS NULL OR alert_sent_at IS NULL;

COMMENT ON TABLE inc_declaration_outbox IS
  'Atomic orchestration of multi-step emergency fan-out. Worker picks up unstamped steps idempotently. Adding a step is a single column addition with zero impact on existing code.';
