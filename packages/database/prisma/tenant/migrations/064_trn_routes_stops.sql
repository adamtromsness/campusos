/*
 * 064_trn_routes_stops.sql — Cycle 19 Step 1.
 *
 * M61 Transportation domain 1: route definitions with ordered stops,
 * student-to-stop assignments with direction and date ranges, parent
 * route-change requests with approval workflow, and the immutable
 * route change audit log.
 *
 * Soft FKs to platform.iam_person and platform.platform_users per
 * ADR-001 / ADR-020 are not enforced at the schema level. Soft FKs
 * to hr_employees and sis_students are scoped to the tenant and are
 * enforced at the application layer in the Step 5 services.
 *
 * No semicolons inside string literals or block comments — the tenant
 * provisioner splits on the semicolon character regardless of context.
 */

CREATE TABLE IF NOT EXISTS trn_routes (
  id                  UUID PRIMARY KEY,
  school_id           UUID NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT,
  direction           TEXT NOT NULL,
  vehicle_id          UUID,
  driver_id           UUID,
  status              TEXT NOT NULL DEFAULT 'ACTIVE',
  academic_year_id    UUID,
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_routes_direction_chk CHECK (direction IN ('AM', 'PM')),
  CONSTRAINT trn_routes_status_chk CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')),
  CONSTRAINT trn_routes_uq UNIQUE (school_id, name, direction, academic_year_id)
);

CREATE INDEX IF NOT EXISTS trn_routes_school_status_idx
  ON trn_routes (school_id, status);
CREATE INDEX IF NOT EXISTS trn_routes_driver_idx
  ON trn_routes (driver_id)
  WHERE driver_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS trn_routes_vehicle_idx
  ON trn_routes (vehicle_id)
  WHERE vehicle_id IS NOT NULL;

COMMENT ON TABLE trn_routes IS
  'Bus route definition with direction (AM, PM). vehicle_id and driver_id are soft refs validated at the application layer. UNIQUE(school, name, direction, academic_year) so the same route name can carry both AM and PM variants in the same year.';

CREATE TABLE IF NOT EXISTS trn_stops (
  id                  UUID PRIMARY KEY,
  route_id            UUID NOT NULL,
  name                TEXT NOT NULL,
  address             TEXT,
  latitude            NUMERIC(9,6),
  longitude           NUMERIC(9,6),
  sequence_order      INT NOT NULL,
  scheduled_time      TIME,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_stops_sequence_chk CHECK (sequence_order > 0),
  CONSTRAINT trn_stops_route_fk FOREIGN KEY (route_id)
    REFERENCES trn_routes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS trn_stops_route_seq_idx
  ON trn_stops (route_id, sequence_order);

COMMENT ON TABLE trn_stops IS
  'Ordered stop on a route. sequence_order > 0 CHECK and INDEX(route_id, sequence_order) back the stop-by-stop pickup or dropoff path. CASCADE on parent route since a stop is meaningless without its route.';

CREATE TABLE IF NOT EXISTS trn_student_assignments (
  id                  UUID PRIMARY KEY,
  student_id          UUID NOT NULL,
  route_id            UUID NOT NULL,
  stop_id             UUID NOT NULL,
  academic_year_id    UUID,
  direction           TEXT NOT NULL,
  effective_from      DATE NOT NULL,
  effective_to        DATE,
  is_override         BOOLEAN NOT NULL DEFAULT false,
  parent_request_id   UUID,
  notes               TEXT,
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_assignments_direction_chk CHECK (direction IN ('AM', 'PM', 'BOTH')),
  CONSTRAINT trn_assignments_dates_chk CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  ),
  CONSTRAINT trn_assignments_route_fk FOREIGN KEY (route_id)
    REFERENCES trn_routes(id) ON DELETE CASCADE,
  CONSTRAINT trn_assignments_stop_fk FOREIGN KEY (stop_id)
    REFERENCES trn_stops(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS trn_assignments_permanent_uq
  ON trn_student_assignments (student_id, academic_year_id)
  WHERE is_override = false;

CREATE INDEX IF NOT EXISTS trn_assignments_route_stop_idx
  ON trn_student_assignments (route_id, stop_id);

CREATE INDEX IF NOT EXISTS trn_assignments_student_active_idx
  ON trn_student_assignments (student_id, effective_from DESC);

COMMENT ON TABLE trn_student_assignments IS
  'Student-to-stop assignment. is_override=true distinguishes one-day overrides created by approved route-change requests from the permanent assignment. Partial UNIQUE(student_id, academic_year_id) WHERE is_override=false caps permanent assignments at one per student per year while letting overrides accumulate.';

CREATE TABLE IF NOT EXISTS trn_route_change_requests (
  id                      UUID PRIMARY KEY,
  school_id               UUID NOT NULL,
  student_id              UUID NOT NULL,
  submitted_by            UUID NOT NULL,
  change_date             DATE NOT NULL,
  change_type             TEXT NOT NULL,
  current_assignment_id   UUID,
  requested_route_id      UUID,
  requested_stop_id       UUID,
  reason                  TEXT,
  status                  TEXT NOT NULL DEFAULT 'PENDING',
  reviewed_by             UUID,
  reviewed_at             TIMESTAMPTZ,
  review_notes            TEXT,
  override_assignment_id  UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_change_type_chk CHECK (
    change_type IN ('DIFFERENT_STOP', 'NO_BUS', 'DIFFERENT_ROUTE')
  ),
  CONSTRAINT trn_change_status_chk CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  CONSTRAINT trn_change_reviewed_chk CHECK (
    (status = 'PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (status IN ('APPROVED', 'REJECTED') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  CONSTRAINT trn_change_route_fk FOREIGN KEY (requested_route_id)
    REFERENCES trn_routes(id) ON DELETE SET NULL,
  CONSTRAINT trn_change_stop_fk FOREIGN KEY (requested_stop_id)
    REFERENCES trn_stops(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS trn_change_student_date_idx
  ON trn_route_change_requests (student_id, change_date DESC);
CREATE INDEX IF NOT EXISTS trn_change_pending_idx
  ON trn_route_change_requests (school_id, status)
  WHERE status = 'PENDING';

COMMENT ON TABLE trn_route_change_requests IS
  'Parent-submitted temporary route change request. 3-value change_type CHECK and 3-value status CHECK with multi-column reviewed_chk lockstep keeping reviewed_by + reviewed_at in sync with non-PENDING. On APPROVED the Step 5 service creates a one-day override assignment and stamps override_assignment_id.';

CREATE TABLE IF NOT EXISTS trn_route_change_log (
  id              UUID PRIMARY KEY,
  route_id        UUID NOT NULL,
  changed_by      UUID NOT NULL,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  change_type     TEXT NOT NULL,
  stop_id         UUID,
  student_id      UUID,
  old_value       JSONB,
  new_value       JSONB,
  reason          TEXT,
  CONSTRAINT trn_log_type_chk CHECK (
    change_type IN (
      'STOP_ADDED', 'STOP_REMOVED', 'STOP_REORDERED', 'STOP_TIME_CHANGED',
      'STUDENT_ADDED', 'STUDENT_REMOVED', 'ROUTE_ACTIVATED', 'ROUTE_DEACTIVATED'
    )
  ),
  CONSTRAINT trn_log_route_fk FOREIGN KEY (route_id)
    REFERENCES trn_routes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS trn_log_route_at_idx
  ON trn_route_change_log (route_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS trn_log_student_idx
  ON trn_route_change_log (student_id)
  WHERE student_id IS NOT NULL;

COMMENT ON TABLE trn_route_change_log IS
  'IMMUTABLE AUDIT per ADR-010. Service-side discipline — no UPDATE and no DELETE methods are exposed at the application layer. 8-value change_type CHECK covers stop add or remove or reorder or time change plus student add or remove plus route activation or deactivation. old_value and new_value JSONB capture the before and after snapshots. FERPA safeguarding record with 7-year retention.';
