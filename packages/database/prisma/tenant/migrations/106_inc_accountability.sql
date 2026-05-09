/*
  Phase 2 Cycle 2 (P2C2) Step 2 - M91 Incident & Emergency, audit + accountability layer.

  5 logical base tables on top of Step 1's incident foundation:

  - inc_incident_timeline IMMUTABLE LEGAL RECORD. Append-only audit
    log of incident events. The TimelineService exposes only
    POST/GET methods - no PATCH and no DELETE at the service layer.
    BRIN INDEX on recorded_at for cheap time-window scans.
    Composite INDEX(incident_id, recorded_at) supports the
    chronological detail view and the after-action report
    auto-generation.

  - inc_accountability_records one row per (incident, person).
    person_type 3-value CHECK (STUDENT, STAFF, VISITOR). status
    5-value CHECK (UNKNOWN, ACCOUNTED_FOR, EVACUATED,
    MEDICAL_ASSISTANCE, MISSING). Multi-column updated_chk keeps
    last_updated_by and last_updated_at in lockstep - either both
    are populated (someone updated the record) or both are NULL
    (initial seed when the outbox creates the row). UNIQUE on
    (incident_id, person_id) so a person appears at most once per
    incident.

  - inc_accountability_summary materialised real-time roll-up.
    UNIQUE on incident_id (one summary row per incident). The Step 6
    AccountabilitySummaryWorker recomputes this row whenever an
    inc_accountability_records row changes status. Counters non-
    negative and total_people equals the sum.

  - inc_reunification_records identity-verified release of a
    student to an adult who is currently signed in via P2C1
    vis_visitors and vis_sign_ins. UNIQUE on (incident_id,
    student_id) so a student is reunified at most once per
    incident. The Step 7 ReunificationService writes:
    (1) reunification record, (2) immutable timeline entry,
    (3) inc_accountability_records.status -> ACCOUNTED_FOR for
    the released student - all in one tenant tx.

  - inc_reunification_corrections audit chain. CASCADE on the
    parent reunification record. correction_reason NOT NULL with
    a service-side minimum length so a one-word "oops" cannot
    correct an identity-verified release. Mirrors Cycle 11
    svc_referral_activity append-only convention.

  Splitter notes: provision-tenant.ts splits on every literal
  semicolon and filters chunks that begin with a line comment.
  No semicolons appear inside any string literal or block comment
  here, and no chunk between CREATE / ALTER / COMMENT statements
  starts with a line comment.

  All FKs in this migration are intra-tenant. recorded_by,
  last_updated_by, released_by, corrected_by are soft refs to
  platform.platform_users(id) per ADR-001 / ADR-020. person_id
  on inc_accountability_records is a soft ref to platform.iam_person
  (no DB FK because person_type tells the read service which
  current-tenant projection table to join). released_to_id is
  enforced by the Step 7 service to be a current vis_visitors row
  with a non-null vis_sign_ins on the day of the incident.
*/

CREATE TABLE IF NOT EXISTS inc_incident_timeline (
  id UUID PRIMARY KEY,
  incident_id UUID NOT NULL,
  recorded_by UUID NOT NULL,
  event_type TEXT NOT NULL,
  description TEXT NOT NULL,
  metadata JSONB,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inc_timeline_incident_fk
    FOREIGN KEY (incident_id) REFERENCES inc_incidents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS inc_timeline_incident_recorded_idx
  ON inc_incident_timeline (incident_id, recorded_at);

CREATE INDEX IF NOT EXISTS inc_timeline_recorded_brin
  ON inc_incident_timeline USING BRIN (recorded_at);

COMMENT ON TABLE inc_incident_timeline IS
  'IMMUTABLE legal record of incident events. Service layer exposes POST and GET only - no UPDATE and no DELETE. After-action report auto-generates from this stream.';

CREATE TABLE IF NOT EXISTS inc_accountability_records (
  id UUID PRIMARY KEY,
  incident_id UUID NOT NULL,
  person_id UUID NOT NULL,
  person_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNKNOWN',
  last_updated_by UUID,
  last_updated_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inc_acc_person_type_chk
    CHECK (person_type IN ('STUDENT', 'STAFF', 'VISITOR')),
  CONSTRAINT inc_acc_status_chk
    CHECK (status IN ('UNKNOWN', 'ACCOUNTED_FOR', 'EVACUATED', 'MEDICAL_ASSISTANCE', 'MISSING')),
  CONSTRAINT inc_acc_updated_chk
    CHECK (
      (last_updated_by IS NULL AND last_updated_at IS NULL)
      OR
      (last_updated_by IS NOT NULL AND last_updated_at IS NOT NULL)
    ),
  CONSTRAINT inc_acc_incident_fk
    FOREIGN KEY (incident_id) REFERENCES inc_incidents(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS inc_acc_incident_person_uq
  ON inc_accountability_records (incident_id, person_id);

CREATE INDEX IF NOT EXISTS inc_acc_status_idx
  ON inc_accountability_records (incident_id, status);

COMMENT ON TABLE inc_accountability_records IS
  'Per-(incident, person) accountability state. The Step 5 outbox seeds rows for every roster member at muster time. The Step 6 AccountabilityService updates status as responders confirm.';

CREATE TABLE IF NOT EXISTS inc_accountability_summary (
  id UUID PRIMARY KEY,
  incident_id UUID NOT NULL UNIQUE,
  total_people INT NOT NULL DEFAULT 0,
  accounted_for INT NOT NULL DEFAULT 0,
  unknown INT NOT NULL DEFAULT 0,
  evacuated INT NOT NULL DEFAULT 0,
  medical_assistance INT NOT NULL DEFAULT 0,
  missing INT NOT NULL DEFAULT 0,
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inc_acc_sum_nonneg_chk
    CHECK (total_people >= 0 AND accounted_for >= 0 AND unknown >= 0
       AND evacuated >= 0 AND medical_assistance >= 0 AND missing >= 0),
  CONSTRAINT inc_acc_sum_total_chk
    CHECK (total_people = accounted_for + unknown + evacuated + medical_assistance + missing),
  CONSTRAINT inc_acc_sum_incident_fk
    FOREIGN KEY (incident_id) REFERENCES inc_incidents(id) ON DELETE CASCADE
);

COMMENT ON TABLE inc_accountability_summary IS
  'Materialised real-time roll-up keyed on incident_id. Recomputed by the Step 6 AccountabilitySummaryWorker on every accountability_records change.';

CREATE TABLE IF NOT EXISTS inc_reunification_records (
  id UUID PRIMARY KEY,
  incident_id UUID NOT NULL,
  student_id UUID NOT NULL,
  released_to_id UUID NOT NULL,
  released_by UUID NOT NULL,
  released_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inc_reun_incident_fk
    FOREIGN KEY (incident_id) REFERENCES inc_incidents(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS inc_reun_incident_student_uq
  ON inc_reunification_records (incident_id, student_id);

CREATE INDEX IF NOT EXISTS inc_reun_incident_released_idx
  ON inc_reunification_records (incident_id, released_at DESC);

COMMENT ON TABLE inc_reunification_records IS
  'Identity-verified student release during emergency reunification. released_to_id is a vis_visitors row that must have an active vis_sign_ins on the incident date - validated at the service layer.';

CREATE TABLE IF NOT EXISTS inc_reunification_corrections (
  id UUID PRIMARY KEY,
  reunification_record_id UUID NOT NULL,
  corrected_by UUID NOT NULL,
  correction_reason TEXT NOT NULL,
  corrected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inc_reun_corr_reun_fk
    FOREIGN KEY (reunification_record_id) REFERENCES inc_reunification_records(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS inc_reun_corr_reun_idx
  ON inc_reunification_corrections (reunification_record_id, corrected_at DESC);

COMMENT ON TABLE inc_reunification_corrections IS
  'Audit chain for reunification corrections. CASCADE on the parent reunification row. Minimum reason length is enforced by the service layer.';
