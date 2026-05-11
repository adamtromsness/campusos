/*
 * 136_trn_fleet_maintenance.sql — Phase 2 Cycle 11 sub-cycle a (P2-11a).
 *
 * M61 Transportation Advanced — Fleet Maintenance plus Fuel plus Driver Hours.
 * 8 base tables. Opens Wave C.
 *
 *   trn_repair_categories          per-school repair classification with
 *                                  is_safety_critical flag. The service
 *                                  layer reads this flag on log-repair
 *                                  and flips trn_vehicles.status to
 *                                  MAINTENANCE until the repair completes.
 *   trn_vehicle_repairs            individual repair record. INTERNAL or
 *                                  EXTERNAL_VENDOR performed_by_type with
 *                                  optional vendor_account_id soft ref to
 *                                  platform_vendor_accounts per ADR-001.
 *                                  3-state status lifecycle SCHEDULED then
 *                                  IN_PROGRESS then COMPLETED — safety
 *                                  critical repairs only release the
 *                                  vehicle on COMPLETED. warranty_claim
 *                                  flag tracks vendor recoveries.
 *   trn_parts_inventory            per-school parts catalogue with
 *                                  quantity_on_hand and min_stock_level.
 *                                  Partial INDEX backs the low-stock
 *                                  dashboard and the trn.parts.low emit.
 *   trn_vehicle_components         tyres brakes batteries belt hose
 *                                  alternator starter transmission and
 *                                  other. installed_mileage plus expected
 *                                  life drives the approaching end of
 *                                  life alert.
 *   trn_vehicle_fuel_logs          per-refuel record. Service layer
 *                                  computes efficiency from the gap
 *                                  between this row and the previous
 *                                  log for the same vehicle.
 *   trn_driver_hours_logs          per-duty period. duty_end_at populated
 *                                  triggers the cumulative_weekly_minutes
 *                                  recompute and the approaching-limit
 *                                  emit. Soft FK on run_id to
 *                                  trn_route_run_logs so a duty period
 *                                  may bind to zero or one runs.
 *   trn_driver_hours_limits        per-school configurable cap. EU
 *                                  Working Time Directive defaults
 *                                  shipped as 2880 weekly and 600 daily
 *                                  minutes. Pre-pilot review reads
 *                                  jurisdiction and tunes if needed.
 *   trn_vehicle_lifecycle          one row per vehicle. Purchase price
 *                                  plus expected life drives replacement
 *                                  planning. STRAIGHT_LINE or
 *                                  DECLINING_BALANCE depreciation
 *                                  recomputed nightly on current_book_value.
 *
 * Soft FKs to platform.iam_person and platform_vendor_accounts per ADR-001
 * and ADR-020 are not enforced at the schema level. DB enforced FKs to
 * hr_employees use ON DELETE SET NULL so a departing driver leaves the
 * historical hours and fuel logs intact for audit. DB enforced FKs to
 * trn_vehicles use ON DELETE CASCADE because repairs and components and
 * fuel logs are meaningless without the parent vehicle.
 *
 * No semicolons inside string literals or block comments. The tenant
 * provisioner splits the migration on every semicolon character without
 * quoting context.
 */

CREATE TABLE IF NOT EXISTS trn_repair_categories (
  id                   UUID PRIMARY KEY,
  school_id            UUID NOT NULL,
  name                 TEXT NOT NULL,
  is_safety_critical   BOOLEAN NOT NULL DEFAULT false,
  is_active            BOOLEAN NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_repair_categories_uq UNIQUE (school_id, name)
);

CREATE INDEX IF NOT EXISTS trn_repair_categories_school_active_idx
  ON trn_repair_categories (school_id, is_active);

COMMENT ON TABLE trn_repair_categories IS
  'Per-school repair classification. is_safety_critical=true means the Step 2 RepairService log-repair path will flip trn_vehicles.status to MAINTENANCE on insert and back to ACTIVE only when the repair lands status=COMPLETED. UNIQUE(school, name) keeps the catalogue clean. is_active for soft deactivation when a category is no longer used.';

CREATE TABLE IF NOT EXISTS trn_vehicle_repairs (
  id                       UUID PRIMARY KEY,
  vehicle_id               UUID NOT NULL,
  category_id              UUID,
  repair_date              DATE NOT NULL,
  mileage_at_repair        INT NOT NULL,
  problem_description      TEXT NOT NULL,
  work_performed           TEXT NOT NULL,
  parts_used               JSONB,
  labour_hours             NUMERIC(5,2),
  total_cost               NUMERIC(10,2) NOT NULL,
  performed_by_type        TEXT NOT NULL,
  vendor_account_id        UUID,
  warranty_claim           BOOLEAN NOT NULL DEFAULT false,
  invoice_s3_key           TEXT,
  status                   TEXT NOT NULL DEFAULT 'COMPLETED',
  scheduled_at             TIMESTAMPTZ,
  started_at               TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_repairs_performed_chk CHECK (
    performed_by_type IN ('INTERNAL', 'EXTERNAL_VENDOR')
  ),
  CONSTRAINT trn_repairs_status_chk CHECK (
    status IN ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')
  ),
  CONSTRAINT trn_repairs_mileage_chk CHECK (mileage_at_repair >= 0),
  CONSTRAINT trn_repairs_labour_chk CHECK (labour_hours IS NULL OR labour_hours >= 0),
  CONSTRAINT trn_repairs_total_chk CHECK (total_cost >= 0),
  CONSTRAINT trn_repairs_vendor_pair_chk CHECK (
    (performed_by_type = 'INTERNAL' AND vendor_account_id IS NULL)
    OR performed_by_type = 'EXTERNAL_VENDOR'
  ),
  CONSTRAINT trn_repairs_completed_chk CHECK (
    (status <> 'COMPLETED' AND completed_at IS NULL)
    OR (status = 'COMPLETED' AND completed_at IS NOT NULL)
  ),
  CONSTRAINT trn_repairs_vehicle_fk FOREIGN KEY (vehicle_id)
    REFERENCES trn_vehicles(id) ON DELETE CASCADE,
  CONSTRAINT trn_repairs_category_fk FOREIGN KEY (category_id)
    REFERENCES trn_repair_categories(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS trn_repairs_vehicle_date_idx
  ON trn_vehicle_repairs (vehicle_id, repair_date DESC);

CREATE INDEX IF NOT EXISTS trn_repairs_open_safety_idx
  ON trn_vehicle_repairs (vehicle_id, status)
  WHERE status IN ('SCHEDULED', 'IN_PROGRESS');

COMMENT ON TABLE trn_vehicle_repairs IS
  'Repair record with 2-value performed_by_type CHECK (INTERNAL vs EXTERNAL_VENDOR) and 4-value status lifecycle (SCHEDULED then IN_PROGRESS then COMPLETED with CANCELLED terminal alternate). Multi-column vendor_pair_chk pins vendor_account_id to NULL on INTERNAL. Multi-column completed_chk keeps completed_at populated only on COMPLETED. category_id nullable FK with SET NULL preserves the repair audit when an obsolete category is removed. The partial INDEX on open repairs backs the GET /transport/repairs/outstanding endpoint. INTERNAL repairs may store a vendor account ref only when the type is EXTERNAL_VENDOR.';

CREATE TABLE IF NOT EXISTS trn_parts_inventory (
  id                  UUID PRIMARY KEY,
  school_id           UUID NOT NULL,
  part_name           TEXT NOT NULL,
  part_number         TEXT,
  quantity_on_hand    INT NOT NULL DEFAULT 0,
  min_stock_level     INT NOT NULL DEFAULT 0,
  unit_cost           NUMERIC(8,2),
  supplier            TEXT,
  last_restocked_at   DATE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_parts_qty_chk CHECK (quantity_on_hand >= 0),
  CONSTRAINT trn_parts_min_chk CHECK (min_stock_level >= 0),
  CONSTRAINT trn_parts_cost_chk CHECK (unit_cost IS NULL OR unit_cost >= 0),
  CONSTRAINT trn_parts_uq UNIQUE (school_id, part_name)
);

CREATE INDEX IF NOT EXISTS trn_parts_low_stock_idx
  ON trn_parts_inventory (school_id, quantity_on_hand)
  WHERE quantity_on_hand <= min_stock_level;

COMMENT ON TABLE trn_parts_inventory IS
  'Per-school parts catalogue. UNIQUE(school, part_name) keeps the catalogue clean. quantity_on_hand and min_stock_level non-negative CHECKs guard against accidental negative restocks. The partial INDEX backs both the GET /transport/parts/low-stock dashboard and the trn.parts.low emit fired by Step 2 PartsService when a movement crosses the threshold.';

CREATE TABLE IF NOT EXISTS trn_vehicle_components (
  id                       UUID PRIMARY KEY,
  vehicle_id               UUID NOT NULL,
  component_type           TEXT NOT NULL,
  description              TEXT,
  installed_date           DATE NOT NULL,
  installed_mileage        INT NOT NULL,
  expected_life_miles      INT,
  expected_life_months     INT,
  warranty_provider        TEXT,
  warranty_expiry_date     DATE,
  status                   TEXT NOT NULL DEFAULT 'ACTIVE',
  replaced_at              TIMESTAMPTZ,
  replaced_by_component_id UUID,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_components_type_chk CHECK (
    component_type IN (
      'TYRE', 'BRAKE', 'BATTERY', 'BELT', 'HOSE',
      'ALTERNATOR', 'STARTER', 'TRANSMISSION', 'OTHER'
    )
  ),
  CONSTRAINT trn_components_status_chk CHECK (
    status IN ('ACTIVE', 'REPLACED', 'FAILED')
  ),
  CONSTRAINT trn_components_mileage_chk CHECK (installed_mileage >= 0),
  CONSTRAINT trn_components_life_miles_chk CHECK (
    expected_life_miles IS NULL OR expected_life_miles > 0
  ),
  CONSTRAINT trn_components_life_months_chk CHECK (
    expected_life_months IS NULL OR expected_life_months > 0
  ),
  CONSTRAINT trn_components_replaced_chk CHECK (
    (status = 'ACTIVE' AND replaced_at IS NULL)
    OR (status IN ('REPLACED', 'FAILED') AND replaced_at IS NOT NULL)
  ),
  CONSTRAINT trn_components_vehicle_fk FOREIGN KEY (vehicle_id)
    REFERENCES trn_vehicles(id) ON DELETE CASCADE,
  CONSTRAINT trn_components_replaced_by_fk FOREIGN KEY (replaced_by_component_id)
    REFERENCES trn_vehicle_components(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS trn_components_active_idx
  ON trn_vehicle_components (vehicle_id, status)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS trn_components_vehicle_installed_idx
  ON trn_vehicle_components (vehicle_id, installed_date DESC);

COMMENT ON TABLE trn_vehicle_components IS
  'Wear-and-replace components per vehicle. 9-value component_type CHECK covers the most common service rotations (TYRE BRAKE BATTERY BELT HOSE ALTERNATOR STARTER TRANSMISSION OTHER). 3-value status CHECK ACTIVE then REPLACED or FAILED. Multi-column replaced_chk pins replaced_at to NULL while ACTIVE. replaced_by_component_id chains a replacement to its predecessor for warranty-claim reconstruction. The partial INDEX on ACTIVE rows backs the approaching end of life query in Step 2 ComponentService.';

CREATE TABLE IF NOT EXISTS trn_vehicle_fuel_logs (
  id                   UUID PRIMARY KEY,
  vehicle_id           UUID NOT NULL,
  logged_by            UUID NOT NULL,
  log_date             DATE NOT NULL,
  odometer_reading     NUMERIC(9,1) NOT NULL,
  fuel_quantity        NUMERIC(7,2) NOT NULL,
  fuel_cost            NUMERIC(8,2),
  fuel_type            TEXT NOT NULL,
  refuel_location      TEXT,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_fuel_type_chk CHECK (
    fuel_type IN ('DIESEL', 'PETROL', 'ELECTRIC', 'HYBRID', 'LPG')
  ),
  CONSTRAINT trn_fuel_odometer_chk CHECK (odometer_reading >= 0),
  CONSTRAINT trn_fuel_quantity_chk CHECK (fuel_quantity > 0),
  CONSTRAINT trn_fuel_cost_chk CHECK (fuel_cost IS NULL OR fuel_cost >= 0),
  CONSTRAINT trn_fuel_vehicle_fk FOREIGN KEY (vehicle_id)
    REFERENCES trn_vehicles(id) ON DELETE CASCADE,
  CONSTRAINT trn_fuel_logged_by_fk FOREIGN KEY (logged_by)
    REFERENCES hr_employees(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS trn_fuel_vehicle_date_idx
  ON trn_vehicle_fuel_logs (vehicle_id, log_date DESC);

COMMENT ON TABLE trn_vehicle_fuel_logs IS
  'Per-refuel record. 5-value fuel_type CHECK covers the typical school-bus fleet (DIESEL PETROL ELECTRIC HYBRID LPG). The Step 2 FuelLogService computes efficiency as (current_odometer - previous_odometer) divided by fuel_quantity by reading the immediately prior row for the same vehicle. fuel_quantity > 0 CHECK rejects no-op zero-quantity rows. CASCADE on vehicle_id since fuel logs are meaningless without their parent vehicle and SET NULL on logged_by preserves the audit when a driver leaves.';

CREATE TABLE IF NOT EXISTS trn_driver_hours_logs (
  id                          UUID PRIMARY KEY,
  driver_id                   UUID NOT NULL,
  run_id                      UUID,
  log_date                    DATE NOT NULL,
  duty_start_at               TIMESTAMPTZ NOT NULL,
  duty_end_at                 TIMESTAMPTZ,
  driving_minutes             INT,
  break_minutes               INT NOT NULL DEFAULT 0,
  cumulative_weekly_minutes   INT,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_hours_window_chk CHECK (
    duty_end_at IS NULL OR duty_end_at > duty_start_at
  ),
  CONSTRAINT trn_hours_driving_chk CHECK (
    driving_minutes IS NULL OR driving_minutes >= 0
  ),
  CONSTRAINT trn_hours_break_chk CHECK (break_minutes >= 0),
  CONSTRAINT trn_hours_cum_chk CHECK (
    cumulative_weekly_minutes IS NULL OR cumulative_weekly_minutes >= 0
  ),
  CONSTRAINT trn_hours_closed_chk CHECK (
    (duty_end_at IS NULL AND cumulative_weekly_minutes IS NULL)
    OR (duty_end_at IS NOT NULL)
  ),
  CONSTRAINT trn_hours_driver_fk FOREIGN KEY (driver_id)
    REFERENCES hr_employees(id) ON DELETE SET NULL,
  CONSTRAINT trn_hours_run_fk FOREIGN KEY (run_id)
    REFERENCES trn_route_run_logs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS trn_hours_driver_date_idx
  ON trn_driver_hours_logs (driver_id, log_date DESC);

CREATE INDEX IF NOT EXISTS trn_hours_open_idx
  ON trn_driver_hours_logs (driver_id)
  WHERE duty_end_at IS NULL;

COMMENT ON TABLE trn_driver_hours_logs IS
  'Per-duty period. Multi-column window_chk keeps duty_end_at strictly after duty_start_at. Multi-column closed_chk pins cumulative_weekly_minutes to NULL while the duty is still open (duty_end_at IS NULL). The Step 2 DriverHoursService recomputes cumulative_weekly_minutes on close from the ISO week of the duty_end_at and emits trn.driver.hours_approaching_limit when the new total crosses 90 percent of the per-school weekly cap. SET NULL on driver_id and run_id keeps historical hours audit intact past employee or run cleanup.';

CREATE TABLE IF NOT EXISTS trn_driver_hours_limits (
  id                              UUID PRIMARY KEY,
  school_id                       UUID NOT NULL UNIQUE,
  weekly_driving_limit_minutes    INT NOT NULL DEFAULT 2880,
  daily_driving_limit_minutes     INT NOT NULL DEFAULT 600,
  mandatory_break_after_minutes   INT NOT NULL DEFAULT 270,
  approaching_limit_threshold_pct INT NOT NULL DEFAULT 90,
  jurisdiction                    TEXT NOT NULL DEFAULT 'US_FEDERAL',
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_hours_limits_weekly_chk CHECK (weekly_driving_limit_minutes > 0),
  CONSTRAINT trn_hours_limits_daily_chk CHECK (daily_driving_limit_minutes > 0),
  CONSTRAINT trn_hours_limits_break_chk CHECK (mandatory_break_after_minutes > 0),
  CONSTRAINT trn_hours_limits_threshold_chk CHECK (
    approaching_limit_threshold_pct BETWEEN 50 AND 100
  )
);

COMMENT ON TABLE trn_driver_hours_limits IS
  'Per-school regulatory cap configuration. UNIQUE(school_id) so each tenant carries exactly one row. Defaults shipped at the EU Working Time Directive shape (2880 minutes per week and 600 minutes per day and a mandatory 45-minute break after 4.5 hours of driving). approaching_limit_threshold_pct is the configurable trigger for the trn.driver.hours_approaching_limit emit and defaults to 90 percent so a driver gets a warning before they hit the cap. jurisdiction is a free-form label for the documentation trail (US_FEDERAL or EU_WTD or UK_DVSA etc).';

CREATE TABLE IF NOT EXISTS trn_vehicle_lifecycle (
  id                       UUID PRIMARY KEY,
  vehicle_id               UUID NOT NULL UNIQUE,
  purchase_date            DATE,
  purchase_price           NUMERIC(10,2),
  expected_life_years      INT,
  expected_life_miles      INT,
  depreciation_method      TEXT NOT NULL DEFAULT 'STRAIGHT_LINE',
  current_book_value       NUMERIC(10,2),
  book_value_computed_at   TIMESTAMPTZ,
  disposal_date            DATE,
  disposal_value           NUMERIC(10,2),
  disposal_method          TEXT,
  disposal_notes           TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_lifecycle_depreciation_chk CHECK (
    depreciation_method IN ('STRAIGHT_LINE', 'DECLINING_BALANCE')
  ),
  CONSTRAINT trn_lifecycle_disposal_method_chk CHECK (
    disposal_method IS NULL
    OR disposal_method IN ('SOLD', 'SCRAPPED', 'TRADED_IN', 'DONATED')
  ),
  CONSTRAINT trn_lifecycle_price_chk CHECK (
    purchase_price IS NULL OR purchase_price >= 0
  ),
  CONSTRAINT trn_lifecycle_life_years_chk CHECK (
    expected_life_years IS NULL OR expected_life_years > 0
  ),
  CONSTRAINT trn_lifecycle_life_miles_chk CHECK (
    expected_life_miles IS NULL OR expected_life_miles > 0
  ),
  CONSTRAINT trn_lifecycle_book_chk CHECK (
    current_book_value IS NULL OR current_book_value >= 0
  ),
  CONSTRAINT trn_lifecycle_disposal_value_chk CHECK (
    disposal_value IS NULL OR disposal_value >= 0
  ),
  CONSTRAINT trn_lifecycle_disposal_pair_chk CHECK (
    (disposal_date IS NULL AND disposal_method IS NULL)
    OR (disposal_date IS NOT NULL AND disposal_method IS NOT NULL)
  ),
  CONSTRAINT trn_lifecycle_vehicle_fk FOREIGN KEY (vehicle_id)
    REFERENCES trn_vehicles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS trn_lifecycle_disposal_idx
  ON trn_vehicle_lifecycle (disposal_date)
  WHERE disposal_date IS NOT NULL;

COMMENT ON TABLE trn_vehicle_lifecycle IS
  'One row per vehicle. UNIQUE(vehicle_id) caps to one lifecycle record per fleet asset. 2-value depreciation_method CHECK (STRAIGHT_LINE vs DECLINING_BALANCE) drives the nightly book-value recompute. Multi-column disposal_pair_chk keeps disposal_date and disposal_method in lockstep so a half-disposed row cannot land. 4-value disposal_method CHECK (SOLD SCRAPPED TRADED_IN DONATED) nullable until the vehicle is actually retired. CASCADE on vehicle_id since the lifecycle has no meaning past the parent vehicle.';
