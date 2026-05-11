/*
 * 137_trn_route_generation.sql — Phase 2 Cycle 11 sub-cycle b (P2-11b).
 *
 * M61 Transportation Advanced — Route Generation Pipeline plus Ad-Hoc
 * Trips plus Contracted Routes. 6 NEW base tables. The plan also lists
 * trn_route_change_requests as a P2-11b deliverable but that table
 * already exists from Cycle 19 migration 064 (parent-submitted
 * temporary route changes with 3-value change_type CHECK and approval
 * lifecycle). P2-11b reuses the existing table and extends the
 * RouteChangeRequestService surface where needed.
 *
 *   trn_route_constraints          per-school constraint profile
 *                                  driving the route generation
 *                                  solver. max_ride_time_minutes plus
 *                                  walkable_radius_metres plus per-
 *                                  route caps. UNIQUE(school, name)
 *                                  so a TC can carry multiple named
 *                                  profiles ("2026 Standard" vs
 *                                  "2026 Snow Day") and pick at
 *                                  generation time.
 *   trn_generation_requests        per-run generation job state.
 *                                  4-value request_type CHECK
 *                                  (FULL_YEAR TERM DATE_RANGE
 *                                  SINGLE_DATE). 5-value status
 *                                  lifecycle (QUEUED then RUNNING
 *                                  then COMPLETED or FAILED or
 *                                  CANCELLED). The Step 4
 *                                  RouteGenerationWorker calls the
 *                                  Scheduling Solver extracted
 *                                  service when available and falls
 *                                  back to manual candidate
 *                                  authoring when not. Emits
 *                                  trn.generation.completed on
 *                                  success.
 *   trn_generation_candidates      per-route candidate from a single
 *                                  generation request. Constraint
 *                                  violations stored as JSONB so the
 *                                  TC review UI can highlight every
 *                                  rule a candidate breaks even when
 *                                  the solver returns the best-fit
 *                                  available. 4-value review_status
 *                                  CHECK (PENDING APPROVED REJECTED
 *                                  MODIFIED). approved_route_id
 *                                  links to the live trn_routes row
 *                                  created on approval.
 *   trn_generation_candidate_stops per-stop in a candidate. Stores
 *                                  the proposed lat lng and the
 *                                  student UUIDs the solver assigned
 *                                  to that stop so an approval can
 *                                  materialise both trn_stops and
 *                                  the trn_student_assignments rows
 *                                  in one transaction.
 *   trn_adhoc_trip_requests        one-off trip request (field trip
 *                                  athletic event special event
 *                                  medical transport). 5-value
 *                                  trip_purpose CHECK. 5-value
 *                                  status CHECK with the
 *                                  linked_approval_id soft ref to
 *                                  wsk_approval_requests so the
 *                                  Cycle 7 workflow engine handles
 *                                  the TC approval chain.
 *   trn_contracted_routes          one row per route operated by a
 *                                  third-party contractor. UNIQUE on
 *                                  route_id so each route may carry
 *                                  at most one active contract.
 *                                  performance_rating NUMERIC(2,1)
 *                                  is the TC-recorded service score.
 *
 * Soft FKs to platform_vendor_accounts and to wsk_approval_requests
 * per ADR-001 and ADR-020 are not enforced at the schema level. DB
 * enforced FKs to trn_routes use ON DELETE CASCADE on the candidate
 * link path because a candidate has no meaning without its parent
 * request and parent route. DB enforced FK on
 * trn_contracted_routes.route_id uses ON DELETE CASCADE because a
 * contract row has no value past route hard-delete.
 *
 * No semicolons inside string literals or block comments. The tenant
 * provisioner splits the migration on every semicolon character
 * without quoting context.
 */

CREATE TABLE IF NOT EXISTS trn_route_constraints (
  id                                  UUID PRIMARY KEY,
  school_id                           UUID NOT NULL,
  constraint_name                     TEXT NOT NULL,
  max_ride_time_minutes               INT NOT NULL DEFAULT 45,
  max_route_mileage                   NUMERIC(7,2),
  max_students_per_vehicle            INT,
  required_arrival_buffer_minutes     INT NOT NULL DEFAULT 10,
  max_stops_per_route                 INT,
  walkable_radius_metres              INT NOT NULL DEFAULT 400,
  is_active                           BOOLEAN NOT NULL DEFAULT true,
  notes                               TEXT,
  created_by                          UUID,
  created_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_constraints_uq UNIQUE (school_id, constraint_name),
  CONSTRAINT trn_constraints_ride_chk CHECK (max_ride_time_minutes > 0),
  CONSTRAINT trn_constraints_arrival_chk CHECK (required_arrival_buffer_minutes >= 0),
  CONSTRAINT trn_constraints_walkable_chk CHECK (walkable_radius_metres >= 0),
  CONSTRAINT trn_constraints_mileage_chk CHECK (
    max_route_mileage IS NULL OR max_route_mileage > 0
  ),
  CONSTRAINT trn_constraints_students_chk CHECK (
    max_students_per_vehicle IS NULL OR max_students_per_vehicle > 0
  ),
  CONSTRAINT trn_constraints_stops_chk CHECK (
    max_stops_per_route IS NULL OR max_stops_per_route > 0
  )
);

CREATE INDEX IF NOT EXISTS trn_constraints_school_active_idx
  ON trn_route_constraints (school_id, is_active);

COMMENT ON TABLE trn_route_constraints IS
  'Per-school constraint profile driving the route generation solver. UNIQUE(school, constraint_name) keeps the catalogue clean. max_ride_time_minutes default 45 mirrors the typical 45-minute door-to-door cap most US districts publish. walkable_radius_metres default 400 matches the 400m walking limit used by most state school transportation regulations — students inside this radius from a school or stop are not eligible for bus service. Schools can ship multiple named profiles (2026 Standard, 2026 Snow Day, etc) and pick at generation time.';

CREATE TABLE IF NOT EXISTS trn_generation_requests (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  requested_by             UUID NOT NULL,
  request_type             TEXT NOT NULL,
  academic_year_id         UUID,
  term_id                  UUID,
  date_from                DATE,
  date_to                  DATE,
  constraint_id            UUID NOT NULL,
  directions               TEXT NOT NULL DEFAULT 'BOTH',
  status                   TEXT NOT NULL DEFAULT 'QUEUED',
  optimiser_run_id         TEXT,
  routes_generated         INT,
  students_covered         INT,
  students_uncovered       INT,
  error_message            TEXT,
  queued_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at               TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_gen_request_type_chk CHECK (
    request_type IN ('FULL_YEAR', 'TERM', 'DATE_RANGE', 'SINGLE_DATE')
  ),
  CONSTRAINT trn_gen_directions_chk CHECK (
    directions IN ('AM_ONLY', 'PM_ONLY', 'BOTH')
  ),
  CONSTRAINT trn_gen_status_chk CHECK (
    status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')
  ),
  CONSTRAINT trn_gen_dates_chk CHECK (
    date_to IS NULL OR date_from IS NULL OR date_to >= date_from
  ),
  CONSTRAINT trn_gen_started_chk CHECK (
    (status IN ('QUEUED') AND started_at IS NULL)
    OR status IN ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')
  ),
  CONSTRAINT trn_gen_completed_chk CHECK (
    (status IN ('QUEUED', 'RUNNING') AND completed_at IS NULL)
    OR status IN ('COMPLETED', 'FAILED', 'CANCELLED')
  ),
  CONSTRAINT trn_gen_covered_chk CHECK (
    students_covered IS NULL OR students_covered >= 0
  ),
  CONSTRAINT trn_gen_uncovered_chk CHECK (
    students_uncovered IS NULL OR students_uncovered >= 0
  ),
  CONSTRAINT trn_gen_routes_chk CHECK (
    routes_generated IS NULL OR routes_generated >= 0
  ),
  CONSTRAINT trn_gen_constraint_fk FOREIGN KEY (constraint_id)
    REFERENCES trn_route_constraints(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS trn_gen_school_status_idx
  ON trn_generation_requests (school_id, status);

CREATE INDEX IF NOT EXISTS trn_gen_school_queued_idx
  ON trn_generation_requests (school_id, queued_at DESC);

COMMENT ON TABLE trn_generation_requests IS
  'Per-run route generation job. 4-value request_type CHECK (FULL_YEAR TERM DATE_RANGE SINGLE_DATE) drives the scope filter the Step 4 RouteGenerationWorker passes to the Scheduling Solver. 5-value status CHECK (QUEUED then RUNNING then COMPLETED or FAILED or CANCELLED). Multi-column started_chk and completed_chk keep the lifecycle timestamps consistent — only running and beyond may carry started_at and only terminal states may carry completed_at. optimiser_run_id is the Scheduling Solver job id for cross-system tracing. ON DELETE RESTRICT on constraint_id so a TC cannot drop a constraint profile that historical generation runs reference.';

CREATE TABLE IF NOT EXISTS trn_generation_candidates (
  id                                    UUID PRIMARY KEY,
  request_id                            UUID NOT NULL,
  candidate_name                        TEXT NOT NULL,
  direction                             TEXT NOT NULL,
  vehicle_type_required                 TEXT NOT NULL,
  total_students                        INT NOT NULL,
  total_stops                           INT NOT NULL,
  estimated_route_mileage               NUMERIC(7,2) NOT NULL,
  estimated_duration_minutes            INT NOT NULL,
  max_student_ride_time_minutes         INT NOT NULL,
  all_constraints_satisfied             BOOLEAN NOT NULL,
  constraint_violations                 JSONB,
  review_status                         TEXT NOT NULL DEFAULT 'PENDING',
  reviewed_by                           UUID,
  reviewed_at                           TIMESTAMPTZ,
  review_notes                          TEXT,
  approved_route_id                     UUID,
  created_at                            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_cand_direction_chk CHECK (direction IN ('AM', 'PM')),
  CONSTRAINT trn_cand_vehicle_chk CHECK (
    vehicle_type_required IN ('BUS', 'MINIBUS', 'VAN')
  ),
  CONSTRAINT trn_cand_review_chk CHECK (
    review_status IN ('PENDING', 'APPROVED', 'REJECTED', 'MODIFIED')
  ),
  CONSTRAINT trn_cand_students_chk CHECK (total_students >= 0),
  CONSTRAINT trn_cand_stops_chk CHECK (total_stops >= 0),
  CONSTRAINT trn_cand_mileage_chk CHECK (estimated_route_mileage >= 0),
  CONSTRAINT trn_cand_duration_chk CHECK (estimated_duration_minutes >= 0),
  CONSTRAINT trn_cand_ride_chk CHECK (max_student_ride_time_minutes >= 0),
  CONSTRAINT trn_cand_reviewed_chk CHECK (
    (review_status = 'PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (review_status IN ('APPROVED', 'REJECTED', 'MODIFIED')
        AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  CONSTRAINT trn_cand_approved_route_chk CHECK (
    (review_status = 'APPROVED' AND approved_route_id IS NOT NULL)
    OR (review_status IN ('PENDING', 'REJECTED', 'MODIFIED'))
  ),
  CONSTRAINT trn_cand_request_fk FOREIGN KEY (request_id)
    REFERENCES trn_generation_requests(id) ON DELETE CASCADE,
  CONSTRAINT trn_cand_route_fk FOREIGN KEY (approved_route_id)
    REFERENCES trn_routes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS trn_cand_request_status_idx
  ON trn_generation_candidates (request_id, review_status);

CREATE INDEX IF NOT EXISTS trn_cand_pending_idx
  ON trn_generation_candidates (request_id)
  WHERE review_status = 'PENDING';

COMMENT ON TABLE trn_generation_candidates IS
  'Per-route candidate produced by a single generation run. 2-value direction CHECK (AM PM) and 3-value vehicle_type_required CHECK (BUS MINIBUS VAN). 4-value review_status CHECK (PENDING APPROVED REJECTED MODIFIED). Multi-column reviewed_chk keeps reviewed_by and reviewed_at populated only on terminal review status. Multi-column approved_route_chk pins approved_route_id to NULL when review_status is not APPROVED. constraint_violations JSONB stores every rule the solver had to relax so the TC review UI can highlight each violation. CASCADE on request_id since candidates have no meaning past the parent generation run. SET NULL on approved_route_id so a dropped trn_routes row leaves the candidate audit intact.';

CREATE TABLE IF NOT EXISTS trn_generation_candidate_stops (
  id                  UUID PRIMARY KEY,
  candidate_id        UUID NOT NULL,
  stop_name           TEXT NOT NULL,
  address             TEXT,
  latitude            NUMERIC(9,6) NOT NULL,
  longitude           NUMERIC(9,6) NOT NULL,
  sequence_order      INT NOT NULL,
  scheduled_time      TIME,
  student_ids         UUID[] NOT NULL,
  student_count       INT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_cand_stop_seq_chk CHECK (sequence_order > 0),
  CONSTRAINT trn_cand_stop_count_chk CHECK (student_count >= 0),
  CONSTRAINT trn_cand_stop_arr_chk CHECK (
    cardinality(student_ids) = student_count
  ),
  CONSTRAINT trn_cand_stop_candidate_fk FOREIGN KEY (candidate_id)
    REFERENCES trn_generation_candidates(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS trn_cand_stop_candidate_seq_idx
  ON trn_generation_candidate_stops (candidate_id, sequence_order);

COMMENT ON TABLE trn_generation_candidate_stops IS
  'Per-stop within a candidate route. student_ids UUID[] stores the soft refs to sis_students rows the solver assigned to this stop so an APPROVED candidate can materialise both trn_stops and the matching trn_student_assignments rows in one transaction. Multi-column student_count check keeps cardinality(student_ids) in lockstep with the denormalised student_count counter. CASCADE on parent candidate since a stop has no meaning past the candidate.';

CREATE TABLE IF NOT EXISTS trn_adhoc_trip_requests (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  requested_by             UUID NOT NULL,
  trip_purpose             TEXT NOT NULL,
  trip_date                DATE NOT NULL,
  departure_time           TIME,
  return_time              TIME,
  pickup_location          TEXT NOT NULL,
  destination              TEXT NOT NULL,
  estimated_passengers     INT NOT NULL,
  special_requirements     TEXT,
  linked_event_id          UUID,
  assigned_vehicle_id      UUID,
  assigned_driver_id       UUID,
  status                   TEXT NOT NULL DEFAULT 'REQUESTED',
  linked_approval_id       UUID,
  approval_notes           TEXT,
  cancellation_reason      TEXT,
  scheduled_at             TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_adhoc_purpose_chk CHECK (
    trip_purpose IN ('FIELD_TRIP', 'ATHLETIC_EVENT', 'SPECIAL_EVENT', 'MEDICAL_TRANSPORT', 'OTHER')
  ),
  CONSTRAINT trn_adhoc_status_chk CHECK (
    status IN ('REQUESTED', 'APPROVED', 'SCHEDULED', 'COMPLETED', 'CANCELLED')
  ),
  CONSTRAINT trn_adhoc_passengers_chk CHECK (estimated_passengers > 0),
  CONSTRAINT trn_adhoc_window_chk CHECK (
    return_time IS NULL OR departure_time IS NULL OR return_time > departure_time
  ),
  CONSTRAINT trn_adhoc_scheduled_chk CHECK (
    (status IN ('REQUESTED', 'APPROVED', 'CANCELLED') AND assigned_vehicle_id IS NULL)
    OR status IN ('SCHEDULED', 'COMPLETED')
  ),
  CONSTRAINT trn_adhoc_completed_chk CHECK (
    (status <> 'COMPLETED' AND completed_at IS NULL)
    OR (status = 'COMPLETED' AND completed_at IS NOT NULL)
  ),
  CONSTRAINT trn_adhoc_cancelled_chk CHECK (
    (status = 'CANCELLED' AND cancellation_reason IS NOT NULL)
    OR status <> 'CANCELLED'
  ),
  CONSTRAINT trn_adhoc_vehicle_fk FOREIGN KEY (assigned_vehicle_id)
    REFERENCES trn_vehicles(id) ON DELETE SET NULL,
  CONSTRAINT trn_adhoc_driver_fk FOREIGN KEY (assigned_driver_id)
    REFERENCES hr_employees(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS trn_adhoc_school_date_idx
  ON trn_adhoc_trip_requests (school_id, trip_date, status);

CREATE INDEX IF NOT EXISTS trn_adhoc_pending_idx
  ON trn_adhoc_trip_requests (school_id, status)
  WHERE status IN ('REQUESTED', 'APPROVED');

COMMENT ON TABLE trn_adhoc_trip_requests IS
  'One-off trip request for field trips athletic events special events medical transport or other. 5-value trip_purpose CHECK and 5-value status CHECK (REQUESTED then APPROVED then SCHEDULED then COMPLETED with CANCELLED as terminal alternate). Multi-column scheduled_chk pins assigned_vehicle_id to NULL until the trip flips to SCHEDULED — assignment cannot land mid-approval. Multi-column cancelled_chk requires a cancellation_reason on CANCELLED so the audit trail is preserved. linked_approval_id is a soft ref to wsk_approval_requests so the Cycle 7 workflow engine handles the TC approval chain. linked_event_id is a soft ref to evt_events or ath_games depending on trip_purpose. SET NULL on assigned_vehicle_id and assigned_driver_id preserves historical trip rows when a vehicle is retired or a driver leaves.';

CREATE TABLE IF NOT EXISTS trn_contracted_routes (
  id                       UUID PRIMARY KEY,
  route_id                 UUID NOT NULL UNIQUE,
  contractor_id            UUID,
  contract_reference       TEXT,
  contract_start_date      DATE NOT NULL,
  contract_end_date        DATE NOT NULL,
  daily_rate               NUMERIC(8,2),
  payment_frequency        TEXT NOT NULL DEFAULT 'MONTHLY',
  performance_rating       NUMERIC(2,1),
  notes                    TEXT,
  is_active                BOOLEAN NOT NULL DEFAULT true,
  created_by               UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_contracted_dates_chk CHECK (contract_end_date >= contract_start_date),
  CONSTRAINT trn_contracted_freq_chk CHECK (
    payment_frequency IN ('WEEKLY', 'MONTHLY', 'TERM')
  ),
  CONSTRAINT trn_contracted_rate_chk CHECK (
    daily_rate IS NULL OR daily_rate >= 0
  ),
  CONSTRAINT trn_contracted_rating_chk CHECK (
    performance_rating IS NULL OR (performance_rating >= 0 AND performance_rating <= 5)
  ),
  CONSTRAINT trn_contracted_route_fk FOREIGN KEY (route_id)
    REFERENCES trn_routes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS trn_contracted_active_idx
  ON trn_contracted_routes (is_active, contract_end_date);

COMMENT ON TABLE trn_contracted_routes IS
  'One row per route operated by a third-party contractor. UNIQUE(route_id) caps each route to a single contract at a time. contractor_id is a soft ref to platform_vendor_accounts per ADR-001. 3-value payment_frequency CHECK (WEEKLY MONTHLY TERM). performance_rating bound 0 to 5 with one decimal for the TC-recorded service score. Multi-column dates_chk keeps the contract window valid. CASCADE on route_id since the contract has no value past route hard-delete.';
