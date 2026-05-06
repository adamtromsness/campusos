/* ============================================================
 * Cycle 21 — Step 3: Inspections + Zones + Supply
 * ============================================================
 *
 * 6 logical base tables completing the Cycle 21 schema phase:
 *
 *   - fac_inspection_types          (per-school catalogue)
 *   - fac_inspections               (immutable once outcome set)
 *   - fac_inspection_violations     (with corrective work order link)
 *   - fac_zones                     (custodial coverage zones)
 *   - fac_zone_assignments          (employee + shift per zone)
 *   - fac_supply_inventory          (per-building stock)
 *
 * Per ADR-034 — Facilities owns where custodians work (zone
 * assignments) and HR owns when they work (shifts). The shift CHECK
 * on fac_zone_assignments is the work-window label, not an HR
 * shift schedule.
 *
 * Splitter-safe — no semicolons inside string literals or block
 * comments. Idempotent — re-runs are a no-op.
 * ============================================================ */

CREATE TABLE IF NOT EXISTS fac_inspection_types (
  id                        UUID PRIMARY KEY,
  school_id                 UUID NOT NULL,
  name                      TEXT NOT NULL,
  authority                 TEXT NOT NULL,
  frequency_months          INT NOT NULL,
  is_mandatory              BOOLEAN NOT NULL DEFAULT true,
  failure_escalation_days   INT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_insp_type_freq_chk CHECK (frequency_months > 0),
  CONSTRAINT fac_insp_type_escal_chk CHECK (
    failure_escalation_days IS NULL OR failure_escalation_days >= 0
  ),
  CONSTRAINT fac_insp_type_uq UNIQUE (school_id, name)
);

CREATE INDEX IF NOT EXISTS fac_insp_type_school_idx
  ON fac_inspection_types (school_id, is_mandatory);

COMMENT ON TABLE fac_inspection_types IS
  'Per-school catalogue of regulated inspection types — Fire Marshal, County Health Department, Elevator State Board, etc. UNIQUE(school_id, name) so the inspection type is a stable handle. frequency_months > 0 CHECK. failure_escalation_days NULL means no automatic escalation timer (FM handles manually).';

CREATE TABLE IF NOT EXISTS fac_inspections (
  id                    UUID PRIMARY KEY,
  school_id             UUID NOT NULL,
  inspection_type_id    UUID NOT NULL,
  building_id           UUID NOT NULL,
  scheduled_date        DATE,
  conducted_date        DATE,
  inspector_name        TEXT,
  inspector_agency      TEXT,
  outcome               TEXT NOT NULL DEFAULT 'PENDING',
  certificate_s3_key    TEXT,
  next_due_date         DATE,
  notes                 TEXT,
  created_by            UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_insp_outcome_chk CHECK (
    outcome IN ('PENDING', 'PASSED', 'PASSED_WITH_CONDITIONS', 'FAILED')
  ),
  CONSTRAINT fac_insp_finalised_chk CHECK (
    (outcome = 'PENDING' AND conducted_date IS NULL)
    OR (outcome <> 'PENDING' AND conducted_date IS NOT NULL)
  ),
  CONSTRAINT fac_insp_type_fk FOREIGN KEY (inspection_type_id)
    REFERENCES fac_inspection_types(id) ON DELETE NO ACTION,
  CONSTRAINT fac_insp_bldg_fk FOREIGN KEY (building_id)
    REFERENCES fac_buildings(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS fac_insp_school_type_due_idx
  ON fac_inspections (school_id, inspection_type_id, next_due_date);

CREATE INDEX IF NOT EXISTS fac_insp_pending_idx
  ON fac_inspections (school_id, scheduled_date)
  WHERE outcome = 'PENDING';

CREATE INDEX IF NOT EXISTS fac_insp_failed_idx
  ON fac_inspections (school_id, conducted_date DESC)
  WHERE outcome IN ('FAILED', 'PASSED_WITH_CONDITIONS');

COMMENT ON TABLE fac_inspections IS
  'Compliance inspection record. 4-value outcome CHECK with multi-column finalised_chk keeping conducted_date populated only when outcome is non-PENDING. NO ACTION on inspection_type_id and building_id preserves the audit trail past type retirement and building deactivation. The Step 7 InspectionService.recordOutcome makes the row IMMUTABLE service-side once outcome is set (no UPDATE that flips it back to PENDING). Emits fac.inspection.failed on FAILED or PASSED_WITH_CONDITIONS.';

COMMENT ON COLUMN fac_inspections.created_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020. NOT NULL for audit.';

CREATE TABLE IF NOT EXISTS fac_inspection_violations (
  id                       UUID PRIMARY KEY,
  inspection_id            UUID NOT NULL,
  description              TEXT NOT NULL,
  severity                 TEXT NOT NULL,
  due_date                 DATE NOT NULL,
  resolved_at              TIMESTAMPTZ,
  resolved_by              UUID,
  resolution_notes         TEXT,
  linked_work_order_id     UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_viol_severity_chk CHECK (severity IN ('MINOR', 'MAJOR', 'CRITICAL')),
  CONSTRAINT fac_viol_resolved_chk CHECK (
    (resolved_at IS NULL AND resolved_by IS NULL)
    OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
  ),
  CONSTRAINT fac_viol_inspection_fk FOREIGN KEY (inspection_id)
    REFERENCES fac_inspections(id) ON DELETE CASCADE,
  CONSTRAINT fac_viol_wo_fk FOREIGN KEY (linked_work_order_id)
    REFERENCES fac_work_orders(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS fac_viol_inspection_idx
  ON fac_inspection_violations (inspection_id);

CREATE INDEX IF NOT EXISTS fac_viol_unresolved_idx
  ON fac_inspection_violations (due_date)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS fac_viol_severity_idx
  ON fac_inspection_violations (severity, due_date)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE fac_inspection_violations IS
  'Per-inspection deficiency line item. 3-value severity CHECK. Multi-column resolved_chk keeps resolved_at + resolved_by all-set or all-null together. CASCADE on parent inspection. SET NULL on linked_work_order_id preserves audit trail when the corrective work order is hard-deleted. Partial unresolved_idx surfaces the active violation queue at constant cost. The Step 7 ViolationService cron emits fac.inspection_violation.overdue when due_date < CURRENT_DATE AND resolved_at IS NULL.';

COMMENT ON COLUMN fac_inspection_violations.resolved_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020. The FM or admin who marked the violation resolved.';

CREATE TABLE IF NOT EXISTS fac_zones (
  id           UUID PRIMARY KEY,
  school_id    UUID NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  color        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_zone_uq UNIQUE (school_id, name)
);

CREATE INDEX IF NOT EXISTS fac_zone_school_idx
  ON fac_zones (school_id);

COMMENT ON TABLE fac_zones IS
  'Per-school custodial zone definition. UNIQUE(school_id, name) so the zone name is the stable handle. color is a TEXT label for the UI badge — accepts any string so schools can choose hex codes or theme tokens.';

CREATE TABLE IF NOT EXISTS fac_zone_assignments (
  id              UUID PRIMARY KEY,
  zone_id         UUID NOT NULL,
  employee_id     UUID NOT NULL,
  effective_from  DATE NOT NULL,
  effective_to    DATE,
  shift           TEXT NOT NULL,
  notes           TEXT,
  created_by      UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_zassign_shift_chk CHECK (
    shift IN ('MORNING', 'AFTERNOON', 'EVENING', 'OVERNIGHT')
  ),
  CONSTRAINT fac_zassign_dates_chk CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  ),
  CONSTRAINT fac_zassign_uq UNIQUE (zone_id, employee_id, effective_from),
  CONSTRAINT fac_zassign_zone_fk FOREIGN KEY (zone_id)
    REFERENCES fac_zones(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fac_zassign_zone_idx
  ON fac_zone_assignments (zone_id, effective_from DESC);

CREATE INDEX IF NOT EXISTS fac_zassign_employee_idx
  ON fac_zone_assignments (employee_id, effective_from DESC);

CREATE INDEX IF NOT EXISTS fac_zassign_active_idx
  ON fac_zone_assignments (zone_id, shift)
  WHERE effective_to IS NULL;

COMMENT ON TABLE fac_zone_assignments IS
  'Per-zone employee assignment record. UNIQUE(zone_id, employee_id, effective_from) lets an employee be re-assigned to the same zone on different start dates while preventing duplicate same-day rows. 4-value shift CHECK is the work-window label (MORNING / AFTERNOON / EVENING / OVERNIGHT) — per ADR-034, Facilities owns where, HR (Cycle 4) owns when. effective_to NULL means the assignment is open-ended. CASCADE on zone delete. employee_id is a soft FK to hr_employees per ADR-001/020.';

COMMENT ON COLUMN fac_zone_assignments.employee_id IS
  'Soft FK to hr_employees(id) per ADR-001/020. The custodian or technician assigned to this zone.';

CREATE TABLE IF NOT EXISTS fac_supply_inventory (
  id                  UUID PRIMARY KEY,
  building_id         UUID NOT NULL,
  item_name           TEXT NOT NULL,
  unit                TEXT NOT NULL,
  current_quantity    NUMERIC(8,2) NOT NULL DEFAULT 0,
  reorder_threshold   NUMERIC(8,2),
  preferred_supplier  TEXT,
  last_restocked_at   TIMESTAMPTZ,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_supply_qty_chk CHECK (current_quantity >= 0),
  CONSTRAINT fac_supply_threshold_chk CHECK (
    reorder_threshold IS NULL OR reorder_threshold >= 0
  ),
  CONSTRAINT fac_supply_uq UNIQUE (building_id, item_name),
  CONSTRAINT fac_supply_bldg_fk FOREIGN KEY (building_id)
    REFERENCES fac_buildings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fac_supply_bldg_idx
  ON fac_supply_inventory (building_id, item_name);

CREATE INDEX IF NOT EXISTS fac_supply_low_idx
  ON fac_supply_inventory (building_id)
  WHERE reorder_threshold IS NOT NULL AND current_quantity < reorder_threshold;

COMMENT ON TABLE fac_supply_inventory IS
  'Per-building cleaning supply stock. UNIQUE(building_id, item_name) so the inventory is a clean catalogue per building. current_quantity >= 0 CHECK keeps stock non-negative (negative pulls require an explicit Phase 2 fac_supply_transactions audit trail). The partial low_idx surfaces below-threshold items at constant cost. The Step 7 SupplyService.adjustQuantity emits fac.supply.reorder_needed on the transition that crosses below the threshold. CASCADE on building delete.';
