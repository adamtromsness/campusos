/*
 * 151_fac_cleaning_supply.sql — Phase 2 Cycle 18 sub-cycle a (P2-18a).
 *
 * M65 Facilities Advanced — 11 of 21 deferred tables. Opens Wave D
 * (Module Completion).
 *
 *   fac_cleaning_routes
 *                                    Per-school custodial cleaning route
 *                                    definition. 4-value shift CHECK
 *                                    (MORNING AFTERNOON EVENING
 *                                    OVERNIGHT). Optional zone_id soft
 *                                    ref to fac_zones for zone-based
 *                                    routes. UNIQUE(school_id, name).
 *   fac_cleaning_route_stops
 *                                    Ordered stops on a cleaning route.
 *                                    cleaning_tasks TEXT[] is the
 *                                    canonical task list (Sweep, Mop,
 *                                    Trash, Sanitize and so on).
 *                                    UNIQUE(route_id, stop_order) and
 *                                    UNIQUE(route_id, space_id) keep
 *                                    each space appearing at most once
 *                                    per route at a stable position.
 *   fac_cleaning_route_assignments
 *                                    Per-route custodian assignment.
 *                                    Two shapes — one-off (is_recurring
 *                                    false + assignment_date set) and
 *                                    recurring (is_recurring true +
 *                                    recurrence_days SMALLINT[] +
 *                                    effective_from + optional
 *                                    effective_to). Partial UNIQUE on
 *                                    (route_id, assignment_date) WHERE
 *                                    is_recurring=false and
 *                                    assignment_date IS NOT NULL caps
 *                                    one-off assignments at one per
 *                                    (route, day) while allowing
 *                                    multiple recurring rows to layer.
 *   fac_cleaning_route_completions
 *                                    Per-(route employee completion_date)
 *                                    run header. 4-value overall_status
 *                                    CHECK (NOT_STARTED IN_PROGRESS
 *                                    COMPLETED PARTIAL). Multi-column
 *                                    timing_chk keeps started_at and
 *                                    completed_at consistent with the
 *                                    lifecycle. UNIQUE(route_id,
 *                                    employee_id, completion_date) caps
 *                                    one run per (route, custodian,
 *                                    day).
 *   fac_cleaning_route_stop_completions
 *                                    Per-stop status within a route run.
 *                                    3-value status CHECK (PENDING
 *                                    COMPLETED SKIPPED). issues_noted
 *                                    text triggers the
 *                                    fac.route_stop.issue_noted Kafka
 *                                    emit at the service layer so the
 *                                    Task Worker creates a tkt_ticket
 *                                    for follow-up. UNIQUE(completion_id,
 *                                    stop_id).
 *   fac_zone_inspections
 *                                    Per-zone supervisor spot check.
 *                                    3-value overall_rating CHECK (PASS
 *                                    NEEDS_IMPROVEMENT FAIL). On FAIL
 *                                    the ZoneInspectionService creates a
 *                                    follow-up fac_work_orders row in
 *                                    the same tenant tx and back-fills
 *                                    follow_up_work_order_id.
 *   fac_supply_transactions
 *                                    Append-only audit trail for every
 *                                    supply movement. 5-value
 *                                    transaction_type CHECK (RECEIPT
 *                                    USAGE ADJUSTMENT TRANSFER
 *                                    WRITE_OFF). quantity_delta is
 *                                    signed — positive for RECEIPTS and
 *                                    positive ADJUSTMENTs, negative for
 *                                    USAGE TRANSFER and WRITE_OFF.
 *                                    reference_id is a soft polymorphic
 *                                    ref interpreted per transaction
 *                                    type (stocktake_id for ADJUSTMENT
 *                                    work_order_id for USAGE on a job
 *                                    et cetera).
 *   fac_supply_stocktakes
 *                                    Per-(building stocktake_date) audit
 *                                    header. 2-value status CHECK
 *                                    (IN_PROGRESS COMPLETED). Multi-
 *                                    column completed_chk keeps
 *                                    completed_at populated only when
 *                                    status=COMPLETED.
 *   fac_supply_stocktake_items
 *                                    Per-(stocktake inventory) expected
 *                                    vs actual count. When the parent
 *                                    stocktake flips to COMPLETED the
 *                                    service creates one ADJUSTMENT
 *                                    fac_supply_transactions row per
 *                                    item where actual_quantity differs
 *                                    from expected_quantity and updates
 *                                    fac_supply_inventory.current_quantity
 *                                    to the actual figure in the same
 *                                    tenant tx. UNIQUE(stocktake_id,
 *                                    inventory_id).
 *   fac_work_order_attachments
 *                                    Per-work-order document attachment.
 *                                    6-value attachment_type CHECK
 *                                    (PHOTO_BEFORE PHOTO_AFTER QUOTE
 *                                    INVOICE REPORT OTHER). s3_key is
 *                                    the storage handle for the signed-
 *                                    URL pattern (matches
 *                                    hr_employee_documents and
 *                                    sis_attendance_evidence). CASCADE
 *                                    on parent work order delete.
 *   fac_work_order_parts
 *                                    Per-work-order parts consumption
 *                                    line item. total_cost is the
 *                                    materialised line total (quantity
 *                                    times unit_cost) so the cost
 *                                    summary endpoint can SUM without
 *                                    re-computing. CASCADE on parent
 *                                    work order delete.
 *
 * FK summary — every cross-table reference is intra-tenant and DB-
 * enforced unless explicitly noted otherwise. zone_id on
 * fac_cleaning_routes is a DB-enforced FK to fac_zones (Cycle 21 Step
 * 3). space_id on fac_cleaning_route_stops is a DB-enforced FK to
 * fac_spaces. building_id on fac_supply_transactions plus
 * fac_supply_stocktakes is a DB-enforced FK to fac_buildings (Cycle 21
 * Step 1). inventory_id on fac_supply_transactions plus
 * fac_supply_stocktake_items is a DB-enforced FK to fac_supply_inventory
 * (Cycle 21 Step 3). work_order_id on fac_work_order_attachments plus
 * fac_work_order_parts is a DB-enforced FK to fac_work_orders (Cycle 21
 * Step 2). zone_id on fac_zone_inspections is a DB-enforced FK to
 * fac_zones. follow_up_work_order_id is a soft ref to fac_work_orders
 * per ADR-001 plus ADR-020 — kept soft because the work order is
 * created in the same tenant tx but follow_up_work_order_id is back-
 * filled and a future re-issue path could orphan the link.
 *
 * employee_id columns on fac_cleaning_route_assignments plus
 * fac_cleaning_route_completions are soft FKs to hr_employees per
 * ADR-001 plus ADR-020. inspector_id plus conducted_by plus performed_by
 * plus uploaded_by plus assigned_by are soft FKs to platform.iam_person
 * per ADR-001 plus ADR-020.
 *
 * Splitter discipline — no semicolons inside string literals default
 * expressions COMMENT bodies CHECK predicates or block comments. The
 * splitter cuts on every semicolon regardless of quoting context.
 * Idempotent — safe to re-run.
 */


CREATE TABLE IF NOT EXISTS fac_cleaning_routes (
  id                          UUID PRIMARY KEY,
  school_id                   UUID NOT NULL,
  name                        TEXT NOT NULL,
  shift                       TEXT NOT NULL,
  zone_id                     UUID,
  estimated_duration_minutes  INT,
  is_active                   BOOLEAN NOT NULL DEFAULT true,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_clean_route_shift_chk CHECK (
    shift IN ('MORNING', 'AFTERNOON', 'EVENING', 'OVERNIGHT')
  ),
  CONSTRAINT fac_clean_route_duration_chk CHECK (
    estimated_duration_minutes IS NULL OR estimated_duration_minutes > 0
  ),
  CONSTRAINT fac_clean_route_uq UNIQUE (school_id, name),
  CONSTRAINT fac_clean_route_zone_fk FOREIGN KEY (zone_id)
    REFERENCES fac_zones(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS fac_clean_route_school_active_idx
  ON fac_cleaning_routes (school_id, is_active);

CREATE INDEX IF NOT EXISTS fac_clean_route_zone_idx
  ON fac_cleaning_routes (zone_id) WHERE zone_id IS NOT NULL;

COMMENT ON TABLE fac_cleaning_routes IS
  'Per-school custodial cleaning route definition. 4-value shift CHECK (MORNING AFTERNOON EVENING OVERNIGHT). Optional zone_id soft ref to fac_zones lets a route inherit a custodial zone for reporting. UNIQUE(school_id, name) so the route name doubles as a stable handle in operational references. is_active=false soft-deactivates a retired route while preserving historical completions and assignments.';

COMMENT ON COLUMN fac_cleaning_routes.school_id IS
  'Soft FK to platform.schools(id) per ADR-001/020.';


CREATE TABLE IF NOT EXISTS fac_cleaning_route_stops (
  id                  UUID PRIMARY KEY,
  route_id            UUID NOT NULL,
  space_id            UUID NOT NULL,
  stop_order          INT NOT NULL,
  estimated_minutes   INT,
  cleaning_tasks      TEXT[] NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_clean_stop_order_chk CHECK (stop_order > 0),
  CONSTRAINT fac_clean_stop_minutes_chk CHECK (
    estimated_minutes IS NULL OR estimated_minutes > 0
  ),
  CONSTRAINT fac_clean_stop_order_uq UNIQUE (route_id, stop_order),
  CONSTRAINT fac_clean_stop_space_uq UNIQUE (route_id, space_id),
  CONSTRAINT fac_clean_stop_route_fk FOREIGN KEY (route_id)
    REFERENCES fac_cleaning_routes(id) ON DELETE CASCADE,
  CONSTRAINT fac_clean_stop_space_fk FOREIGN KEY (space_id)
    REFERENCES fac_spaces(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS fac_clean_stop_route_order_idx
  ON fac_cleaning_route_stops (route_id, stop_order);

COMMENT ON TABLE fac_cleaning_route_stops IS
  'Ordered stops within a cleaning route. cleaning_tasks TEXT[] is the per-stop task list (Sweep Mop Trash Sanitize Refill Soap and so on) that the per-stop completion row references. UNIQUE(route_id, stop_order) caps each position at one space and UNIQUE(route_id, space_id) prevents the same space appearing twice on one route. CASCADE on route delete. RESTRICT on space delete so a space cannot be hard-removed while it is wired into an active route — admins should soft-deactivate the route first.';


CREATE TABLE IF NOT EXISTS fac_cleaning_route_assignments (
  id                  UUID PRIMARY KEY,
  route_id            UUID NOT NULL,
  employee_id         UUID NOT NULL,
  assignment_date     DATE,
  is_recurring        BOOLEAN NOT NULL DEFAULT false,
  recurrence_days     SMALLINT[],
  effective_from      DATE,
  effective_to        DATE,
  assigned_by         UUID NOT NULL,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_clean_assign_shape_chk CHECK (
    (is_recurring = false AND assignment_date IS NOT NULL AND recurrence_days IS NULL AND effective_from IS NULL AND effective_to IS NULL)
    OR (is_recurring = true AND assignment_date IS NULL AND recurrence_days IS NOT NULL AND cardinality(recurrence_days) > 0 AND effective_from IS NOT NULL)
  ),
  CONSTRAINT fac_clean_assign_dates_chk CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  ),
  CONSTRAINT fac_clean_assign_route_fk FOREIGN KEY (route_id)
    REFERENCES fac_cleaning_routes(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS fac_clean_assign_oneoff_uq
  ON fac_cleaning_route_assignments (route_id, assignment_date)
  WHERE is_recurring = false AND assignment_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS fac_clean_assign_employee_idx
  ON fac_cleaning_route_assignments (employee_id, assignment_date DESC);

CREATE INDEX IF NOT EXISTS fac_clean_assign_recurring_idx
  ON fac_cleaning_route_assignments (route_id, effective_from)
  WHERE is_recurring = true;

COMMENT ON TABLE fac_cleaning_route_assignments IS
  'Per-route custodian assignment record. Two shapes enforced by shape_chk — one-off (is_recurring=false plus assignment_date plus recurrence fields NULL) and recurring (is_recurring=true plus recurrence_days non-empty plus effective_from set plus optional effective_to). The partial UNIQUE on (route_id, assignment_date) WHERE is_recurring=false caps one-off rows at one per (route, day). Recurring rows can layer freely so an admin can schedule different custodians on different weekdays. CASCADE on route delete.';

COMMENT ON COLUMN fac_cleaning_route_assignments.employee_id IS
  'Soft FK to hr_employees(id) per ADR-001/020. The custodian assigned to run this route.';

COMMENT ON COLUMN fac_cleaning_route_assignments.assigned_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020. The FM or admin who created the assignment.';


CREATE TABLE IF NOT EXISTS fac_cleaning_route_completions (
  id                  UUID PRIMARY KEY,
  route_id            UUID NOT NULL,
  assignment_id       UUID NOT NULL,
  employee_id         UUID NOT NULL,
  completion_date     DATE NOT NULL,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  overall_status      TEXT NOT NULL DEFAULT 'NOT_STARTED',
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_clean_compl_status_chk CHECK (
    overall_status IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'PARTIAL')
  ),
  CONSTRAINT fac_clean_compl_timing_chk CHECK (
    (overall_status = 'NOT_STARTED' AND started_at IS NULL AND completed_at IS NULL)
    OR (overall_status = 'IN_PROGRESS' AND started_at IS NOT NULL AND completed_at IS NULL)
    OR (overall_status IN ('COMPLETED', 'PARTIAL') AND started_at IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT fac_clean_compl_uq UNIQUE (route_id, employee_id, completion_date),
  CONSTRAINT fac_clean_compl_route_fk FOREIGN KEY (route_id)
    REFERENCES fac_cleaning_routes(id) ON DELETE RESTRICT,
  CONSTRAINT fac_clean_compl_assign_fk FOREIGN KEY (assignment_id)
    REFERENCES fac_cleaning_route_assignments(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS fac_clean_compl_date_idx
  ON fac_cleaning_route_completions (completion_date DESC, route_id);

CREATE INDEX IF NOT EXISTS fac_clean_compl_employee_idx
  ON fac_cleaning_route_completions (employee_id, completion_date DESC);

COMMENT ON TABLE fac_cleaning_route_completions IS
  'Per-(route employee completion_date) run header. 4-value overall_status CHECK (NOT_STARTED IN_PROGRESS COMPLETED PARTIAL). Multi-column timing_chk keeps started_at and completed_at in lockstep with the lifecycle. UNIQUE(route_id, employee_id, completion_date) caps one run per (route, custodian, day). RESTRICT on route and assignment deletion so historical completions are preserved — admin should soft-deactivate the parent route instead.';

COMMENT ON COLUMN fac_cleaning_route_completions.employee_id IS
  'Soft FK to hr_employees(id) per ADR-001/020. The custodian who ran the route.';


CREATE TABLE IF NOT EXISTS fac_cleaning_route_stop_completions (
  id                  UUID PRIMARY KEY,
  completion_id       UUID NOT NULL,
  stop_id             UUID NOT NULL,
  status              TEXT NOT NULL DEFAULT 'PENDING',
  completed_at        TIMESTAMPTZ,
  skip_reason         TEXT,
  tasks_completed     TEXT[] NOT NULL DEFAULT '{}',
  photo_s3_keys       TEXT[] NOT NULL DEFAULT '{}',
  issues_noted        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_clean_stop_compl_status_chk CHECK (
    status IN ('PENDING', 'COMPLETED', 'SKIPPED')
  ),
  CONSTRAINT fac_clean_stop_compl_timing_chk CHECK (
    (status = 'PENDING' AND completed_at IS NULL)
    OR (status = 'COMPLETED' AND completed_at IS NOT NULL)
    OR (status = 'SKIPPED' AND completed_at IS NOT NULL AND skip_reason IS NOT NULL AND length(trim(skip_reason)) > 0)
  ),
  CONSTRAINT fac_clean_stop_compl_uq UNIQUE (completion_id, stop_id),
  CONSTRAINT fac_clean_stop_compl_completion_fk FOREIGN KEY (completion_id)
    REFERENCES fac_cleaning_route_completions(id) ON DELETE CASCADE,
  CONSTRAINT fac_clean_stop_compl_stop_fk FOREIGN KEY (stop_id)
    REFERENCES fac_cleaning_route_stops(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS fac_clean_stop_compl_completion_idx
  ON fac_cleaning_route_stop_completions (completion_id);

CREATE INDEX IF NOT EXISTS fac_clean_stop_compl_issues_idx
  ON fac_cleaning_route_stop_completions (completion_id)
  WHERE issues_noted IS NOT NULL;

COMMENT ON TABLE fac_cleaning_route_stop_completions IS
  'Per-stop status within a route run. 3-value status CHECK (PENDING COMPLETED SKIPPED). Multi-column timing_chk enforces PENDING with no completed_at, COMPLETED with completed_at populated, and SKIPPED with completed_at populated plus a non-empty skip_reason — schools demand a reason for every skipped stop. tasks_completed is the subset of the parent stop cleaning_tasks the custodian actually finished. photo_s3_keys is the signed-URL handle list for evidence photos. When issues_noted is non-NULL the CleaningRouteService emits fac.route_stop.issue_noted so the Task Worker creates a tkt_ticket. CASCADE on completion delete. RESTRICT on stop delete preserves history.';


CREATE TABLE IF NOT EXISTS fac_zone_inspections (
  id                          UUID PRIMARY KEY,
  zone_id                     UUID NOT NULL,
  inspector_id                UUID NOT NULL,
  inspection_date             DATE NOT NULL,
  overall_rating              TEXT NOT NULL,
  notes                       TEXT,
  follow_up_required          BOOLEAN NOT NULL DEFAULT false,
  follow_up_work_order_id     UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_zone_insp_rating_chk CHECK (
    overall_rating IN ('PASS', 'NEEDS_IMPROVEMENT', 'FAIL')
  ),
  CONSTRAINT fac_zone_insp_followup_chk CHECK (
    follow_up_required = false OR overall_rating IN ('NEEDS_IMPROVEMENT', 'FAIL')
  ),
  CONSTRAINT fac_zone_insp_zone_fk FOREIGN KEY (zone_id)
    REFERENCES fac_zones(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fac_zone_insp_zone_date_idx
  ON fac_zone_inspections (zone_id, inspection_date DESC);

CREATE INDEX IF NOT EXISTS fac_zone_insp_followup_idx
  ON fac_zone_inspections (follow_up_work_order_id)
  WHERE follow_up_work_order_id IS NOT NULL;

COMMENT ON TABLE fac_zone_inspections IS
  'Per-zone supervisor spot check. 3-value overall_rating CHECK (PASS NEEDS_IMPROVEMENT FAIL). On FAIL the ZoneInspectionService creates a follow-up fac_work_orders row in the same tenant tx and back-fills follow_up_work_order_id so the inspection record carries the auto-generated audit chain forward. follow_up_required and follow_up_work_order_id are independent — an inspector can flag a NEEDS_IMPROVEMENT outcome for follow-up without auto-creating a work order (that path is FAIL-only). CASCADE on zone delete.';

COMMENT ON COLUMN fac_zone_inspections.inspector_id IS
  'Soft FK to platform.iam_person(id) per ADR-001/020. The FM supervisor who conducted the inspection.';

COMMENT ON COLUMN fac_zone_inspections.follow_up_work_order_id IS
  'Soft polymorphic ref to fac_work_orders(id) per ADR-001/020. Back-filled by ZoneInspectionService on FAIL outcomes. Kept soft so a future inspection re-issue or work order replacement does not orphan the FK.';


CREATE TABLE IF NOT EXISTS fac_supply_transactions (
  id                  UUID PRIMARY KEY,
  building_id         UUID NOT NULL,
  inventory_id        UUID NOT NULL,
  transaction_type    TEXT NOT NULL,
  quantity_delta      NUMERIC(8,2) NOT NULL,
  performed_by        UUID NOT NULL,
  transaction_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reference_id        UUID,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_supply_tx_type_chk CHECK (
    transaction_type IN ('RECEIPT', 'USAGE', 'ADJUSTMENT', 'TRANSFER', 'WRITE_OFF')
  ),
  CONSTRAINT fac_supply_tx_delta_chk CHECK (quantity_delta <> 0),
  CONSTRAINT fac_supply_tx_building_fk FOREIGN KEY (building_id)
    REFERENCES fac_buildings(id) ON DELETE RESTRICT,
  CONSTRAINT fac_supply_tx_inventory_fk FOREIGN KEY (inventory_id)
    REFERENCES fac_supply_inventory(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS fac_supply_tx_inventory_idx
  ON fac_supply_transactions (inventory_id, transaction_at DESC);

CREATE INDEX IF NOT EXISTS fac_supply_tx_building_date_idx
  ON fac_supply_transactions (building_id, transaction_at DESC);

CREATE INDEX IF NOT EXISTS fac_supply_tx_reference_idx
  ON fac_supply_transactions (reference_id)
  WHERE reference_id IS NOT NULL;

COMMENT ON TABLE fac_supply_transactions IS
  'Append-only audit trail for every supply movement. 5-value transaction_type CHECK (RECEIPT USAGE ADJUSTMENT TRANSFER WRITE_OFF). quantity_delta is signed — positive for RECEIPTS and positive ADJUSTMENTs, negative for USAGE TRANSFER and WRITE_OFF. The service applies the delta atomically to fac_supply_inventory.current_quantity in the same tenant tx as the insert so the rolling balance and the transaction log stay consistent. reference_id is a soft polymorphic ref interpreted per transaction type — stocktake_id for ADJUSTMENT created during stocktake completion, work_order_id for USAGE on a work order, building_id for TRANSFER targets. RESTRICT on building and inventory deletion preserves history.';

COMMENT ON COLUMN fac_supply_transactions.performed_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020. The custodian or admin who recorded the movement.';


CREATE TABLE IF NOT EXISTS fac_supply_stocktakes (
  id                  UUID PRIMARY KEY,
  school_id           UUID NOT NULL,
  building_id         UUID NOT NULL,
  conducted_by        UUID NOT NULL,
  stocktake_date      DATE NOT NULL,
  status              TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  completed_at        TIMESTAMPTZ,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_supply_stk_status_chk CHECK (
    status IN ('IN_PROGRESS', 'COMPLETED')
  ),
  CONSTRAINT fac_supply_stk_completed_chk CHECK (
    (status = 'IN_PROGRESS' AND completed_at IS NULL)
    OR (status = 'COMPLETED' AND completed_at IS NOT NULL)
  ),
  CONSTRAINT fac_supply_stk_building_fk FOREIGN KEY (building_id)
    REFERENCES fac_buildings(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS fac_supply_stk_building_date_idx
  ON fac_supply_stocktakes (building_id, stocktake_date DESC);

CREATE INDEX IF NOT EXISTS fac_supply_stk_school_status_idx
  ON fac_supply_stocktakes (school_id, status, stocktake_date DESC);

COMMENT ON TABLE fac_supply_stocktakes IS
  'Per-(building stocktake_date) audit header. 2-value status CHECK (IN_PROGRESS COMPLETED). Multi-column completed_chk keeps completed_at populated only when status=COMPLETED. RESTRICT on building delete preserves history. The SupplyAuditService.completeStocktake flips status to COMPLETED inside one tenant tx that also creates ADJUSTMENT fac_supply_transactions rows for every item where actual_quantity differs from expected_quantity and updates fac_supply_inventory.current_quantity to the actual figure.';

COMMENT ON COLUMN fac_supply_stocktakes.school_id IS
  'Soft FK to platform.schools(id) per ADR-001/020.';

COMMENT ON COLUMN fac_supply_stocktakes.conducted_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020. The custodian or admin running the stocktake.';


CREATE TABLE IF NOT EXISTS fac_supply_stocktake_items (
  id                  UUID PRIMARY KEY,
  stocktake_id        UUID NOT NULL,
  inventory_id        UUID NOT NULL,
  expected_quantity   NUMERIC(8,2) NOT NULL,
  actual_quantity     NUMERIC(8,2) NOT NULL,
  discrepancy_notes   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_supply_stk_item_expected_chk CHECK (expected_quantity >= 0),
  CONSTRAINT fac_supply_stk_item_actual_chk CHECK (actual_quantity >= 0),
  CONSTRAINT fac_supply_stk_item_uq UNIQUE (stocktake_id, inventory_id),
  CONSTRAINT fac_supply_stk_item_stocktake_fk FOREIGN KEY (stocktake_id)
    REFERENCES fac_supply_stocktakes(id) ON DELETE CASCADE,
  CONSTRAINT fac_supply_stk_item_inventory_fk FOREIGN KEY (inventory_id)
    REFERENCES fac_supply_inventory(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS fac_supply_stk_item_discrepancy_idx
  ON fac_supply_stocktake_items (stocktake_id)
  WHERE expected_quantity <> actual_quantity;

COMMENT ON TABLE fac_supply_stocktake_items IS
  'Per-(stocktake inventory) expected vs actual count. Both quantities non-negative CHECK. UNIQUE(stocktake_id, inventory_id) so a stocktake records each inventory item at most once. The partial discrepancy_idx surfaces all rows where actual differs from expected for the SupplyAuditService.completeStocktake adjustment fan-out. CASCADE on parent stocktake delete. RESTRICT on inventory delete preserves history.';


CREATE TABLE IF NOT EXISTS fac_work_order_attachments (
  id                  UUID PRIMARY KEY,
  work_order_id       UUID NOT NULL,
  s3_key              TEXT NOT NULL,
  filename            TEXT NOT NULL,
  attachment_type     TEXT NOT NULL DEFAULT 'OTHER',
  file_size_bytes     BIGINT,
  uploaded_by         UUID NOT NULL,
  uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_wo_att_type_chk CHECK (
    attachment_type IN ('PHOTO_BEFORE', 'PHOTO_AFTER', 'QUOTE', 'INVOICE', 'REPORT', 'OTHER')
  ),
  CONSTRAINT fac_wo_att_size_chk CHECK (
    file_size_bytes IS NULL OR file_size_bytes >= 0
  ),
  CONSTRAINT fac_wo_att_wo_fk FOREIGN KEY (work_order_id)
    REFERENCES fac_work_orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fac_wo_att_wo_type_idx
  ON fac_work_order_attachments (work_order_id, attachment_type);

CREATE INDEX IF NOT EXISTS fac_wo_att_uploaded_idx
  ON fac_work_order_attachments (work_order_id, uploaded_at DESC);

COMMENT ON TABLE fac_work_order_attachments IS
  'Per-work-order document attachment. 6-value attachment_type CHECK (PHOTO_BEFORE PHOTO_AFTER QUOTE INVOICE REPORT OTHER). s3_key is the storage handle for the signed-URL pattern matching hr_employee_documents and sis_attendance_evidence. CASCADE on parent work order delete so attachments do not outlive their work order.';

COMMENT ON COLUMN fac_work_order_attachments.uploaded_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020. The FM or admin who uploaded the document.';


CREATE TABLE IF NOT EXISTS fac_work_order_parts (
  id                  UUID PRIMARY KEY,
  work_order_id       UUID NOT NULL,
  part_name           TEXT NOT NULL,
  quantity            NUMERIC(8,2) NOT NULL,
  unit                TEXT,
  unit_cost           NUMERIC(8,2),
  total_cost          NUMERIC(10,2),
  supplier            TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_wo_parts_qty_chk CHECK (quantity > 0),
  CONSTRAINT fac_wo_parts_unit_cost_chk CHECK (
    unit_cost IS NULL OR unit_cost >= 0
  ),
  CONSTRAINT fac_wo_parts_total_chk CHECK (
    total_cost IS NULL OR total_cost >= 0
  ),
  CONSTRAINT fac_wo_parts_wo_fk FOREIGN KEY (work_order_id)
    REFERENCES fac_work_orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fac_wo_parts_wo_idx
  ON fac_work_order_parts (work_order_id);

COMMENT ON TABLE fac_work_order_parts IS
  'Per-work-order parts consumption line item. total_cost is the materialised line total (quantity times unit_cost) so the cost summary endpoint can SUM without re-computing. Both unit_cost and total_cost are nullable for parts where cost was not captured at consumption time. CASCADE on parent work order delete.';
