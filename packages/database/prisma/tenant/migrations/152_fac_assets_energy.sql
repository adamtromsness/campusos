/*
 * 152_fac_assets_energy.sql — Phase 2 Cycle 18 sub-cycle b (P2-18b).
 *
 * M65 Facilities Advanced — 10 of 21 deferred tables. Closes P2-18.
 * Cumulative P2-18 schema delta: 21 new fac_* tables across 2
 * migrations (151 + 152). Opens Wave D (Module Completion).
 *
 *   fac_fire_drills
 *                                    Per-(building drill_date) fire drill
 *                                    record. duration_seconds and
 *                                    evacuation_time_seconds non-negative
 *                                    CHECK. met_target computed by the
 *                                    service from
 *                                    target_evacuation_seconds at insert
 *                                    time. Compliance alert fires when
 *                                    no drill landed for a building in
 *                                    the last 90 days — the
 *                                    FireDrillService.compliance endpoint
 *                                    LEFT JOINs every fac_buildings row
 *                                    against the most-recent drill and
 *                                    flags overdue rows.
 *   fac_asset_categories
 *                                    Per-school catalogue of asset
 *                                    categories (HVAC Electrical
 *                                    Plumbing Elevator FireSafety and so
 *                                    on). depreciation_years and
 *                                    maintenance_interval_months drive
 *                                    the replacement-planning + overdue-
 *                                    maintenance dashboards. UNIQUE on
 *                                    (school_id, name).
 *   fac_assets
 *                                    Individual facilities asset record.
 *                                    3-value status CHECK (ACTIVE
 *                                    UNDER_MAINTENANCE DECOMMISSIONED).
 *                                    4-value replacement_priority CHECK
 *                                    (LOW MEDIUM HIGH CRITICAL).
 *                                    Optional serial_number with partial
 *                                    UNIQUE on (school_id, serial_number)
 *                                    WHERE serial_number IS NOT NULL so
 *                                    serial-tracked assets cannot
 *                                    duplicate while serial-less assets
 *                                    (consumables) can layer freely.
 *                                    install_date plus
 *                                    expected_lifespan_years feed the
 *                                    replacement-planning query.
 *   fac_asset_maintenance_records
 *                                    Per-asset maintenance log. 4-value
 *                                    maintenance_type CHECK (SCHEDULED
 *                                    CORRECTIVE EMERGENCY INSPECTION).
 *                                    next_maintenance_date when populated
 *                                    feeds the overdue-maintenance
 *                                    dashboard — the service flags rows
 *                                    where the latest record on an asset
 *                                    has next_maintenance_date in the
 *                                    past.
 *   fac_asset_disposals
 *                                    Per-asset disposal record. UNIQUE
 *                                    on asset_id so each asset can be
 *                                    disposed at most once.
 *                                    6-value disposal_method CHECK
 *                                    (AUCTION DONATION SKIP TRADE_IN
 *                                    SCRAP TRANSFER). value_recovered
 *                                    when set is non-negative.
 *                                    SAFETY KEYSTONE — the AssetService
 *                                    dispose path refuses to create a
 *                                    row unless the parent fac_assets
 *                                    row has status=DECOMMISSIONED. The
 *                                    schema cannot encode the cross-row
 *                                    invariant directly so the service
 *                                    layer is the authoritative gate
 *                                    (matching the Cycle 6 invoice
 *                                    cancel-and-refund pattern).
 *   fac_utility_meters
 *                                    Per-(building meter_name) utility
 *                                    meter. 5-value utility_type CHECK
 *                                    (ELECTRICITY GAS WATER HEATING_OIL
 *                                    SOLAR). unit free-form text (kWh
 *                                    therms gallons litres) — schools
 *                                    set the unit at meter creation and
 *                                    the dashboard renders verbatim.
 *                                    UNIQUE on (school_id, meter_name).
 *   fac_energy_readings
 *                                    Per-(meter reading_date) raw
 *                                    reading. KEYSTONE — consumption
 *                                    auto-computed at insert time by the
 *                                    EnergyService as
 *                                    (current.reading_value minus the
 *                                    most-recent earlier reading_value
 *                                    on the same meter) so the dashboard
 *                                    can SUM a window without a window
 *                                    function. NULL consumption on the
 *                                    first reading per meter (no prior
 *                                    row to subtract). UNIQUE on
 *                                    (meter_id, reading_date).
 *   fac_energy_targets
 *                                    Per-(school utility_type
 *                                    target_period academic_year) target.
 *                                    2-value target_period CHECK
 *                                    (MONTHLY ANNUAL). UNIQUE with
 *                                    COALESCE-sentinel on academic_year
 *                                    so a row with NULL academic_year
 *                                    (rolling baseline) coexists with
 *                                    named-year overrides — same
 *                                    sentinel pattern as Cycle 5
 *                                    sch_periods + Cycle 6
 *                                    enr_intake_capacities + Cycle 12
 *                                    lib_reading_lists.
 *   fac_space_utilization_records
 *                                    Per-(space record_date period)
 *                                    occupancy snapshot. occupancy_count
 *                                    and capacity non-negative.
 *                                    utilisation_rate is the
 *                                    materialised (occupancy / capacity)
 *                                    ratio so the underused-space
 *                                    dashboard can filter without
 *                                    division-by-zero juggling. UNIQUE
 *                                    on (space_id, record_date,
 *                                    COALESCE(period_id, sentinel)) so
 *                                    daily aggregate rows (period_id
 *                                    NULL) coexist with per-period
 *                                    breakdowns.
 *   fac_sustainability_initiatives
 *                                    Per-school sustainability program.
 *                                    5-value category CHECK (ENERGY
 *                                    WATER WASTE TRANSPORT BIODIVERSITY).
 *                                    3-value status CHECK (ACTIVE
 *                                    COMPLETED CANCELLED). UNIQUE on
 *                                    (school_id, name).
 *
 * FK summary — every cross-table reference is intra-tenant and DB-
 * enforced unless explicitly noted otherwise. building_id on
 * fac_fire_drills + fac_assets + fac_utility_meters is a DB-enforced FK
 * to fac_buildings (Cycle 21 Step 1). space_id on fac_assets +
 * fac_space_utilization_records is a DB-enforced FK to fac_spaces.
 * category_id on fac_assets is a DB-enforced FK to fac_asset_categories.
 * asset_id on fac_asset_maintenance_records + fac_asset_disposals is a
 * DB-enforced FK to fac_assets. meter_id on fac_energy_readings is a
 * DB-enforced FK to fac_utility_meters. period_id on
 * fac_space_utilization_records is a DB-enforced FK to sch_periods.
 *
 * conducted_by + recorded_by + performed_by + disposed_by +
 * authorised_by columns are soft FKs to platform.iam_person per ADR-001
 * plus ADR-020.
 *
 * Splitter discipline — no semicolons inside string literals default
 * expressions COMMENT bodies CHECK predicates or block comments. The
 * splitter cuts on every semicolon regardless of quoting context.
 * Idempotent — safe to re-run.
 */


CREATE TABLE IF NOT EXISTS fac_fire_drills (
  id                          UUID PRIMARY KEY,
  school_id                   UUID NOT NULL,
  building_id                 UUID NOT NULL,
  drill_date                  DATE NOT NULL,
  drill_time                  TIME NOT NULL,
  duration_seconds            INT NOT NULL,
  total_occupants             INT NOT NULL,
  evacuation_time_seconds     INT NOT NULL,
  target_evacuation_seconds   INT,
  met_target                  BOOLEAN,
  issues_noted                TEXT,
  conducted_by                UUID NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_fire_drill_duration_chk CHECK (duration_seconds >= 0),
  CONSTRAINT fac_fire_drill_evac_chk CHECK (evacuation_time_seconds >= 0),
  CONSTRAINT fac_fire_drill_occupants_chk CHECK (total_occupants >= 0),
  CONSTRAINT fac_fire_drill_target_chk CHECK (
    target_evacuation_seconds IS NULL OR target_evacuation_seconds > 0
  ),
  CONSTRAINT fac_fire_drill_building_fk FOREIGN KEY (building_id)
    REFERENCES fac_buildings(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS fac_fire_drill_building_date_idx
  ON fac_fire_drills (building_id, drill_date DESC);

CREATE INDEX IF NOT EXISTS fac_fire_drill_school_date_idx
  ON fac_fire_drills (school_id, drill_date DESC);

COMMENT ON TABLE fac_fire_drills IS
  'Per-(building drill_date) fire drill record. duration_seconds plus evacuation_time_seconds non-negative CHECK. met_target is computed by the FireDrillService at insert time when target_evacuation_seconds is set (evacuation_time_seconds is less than or equal to target_evacuation_seconds equals true). The compliance endpoint LEFT JOINs every fac_buildings row against the most-recent drill and flags rows where no drill landed in the last 90 days — emits fac.fire_drill.overdue per overdue building. RESTRICT on building delete preserves the audit chain.';

COMMENT ON COLUMN fac_fire_drills.school_id IS
  'Soft FK to platform.schools(id) per ADR-001/020.';

COMMENT ON COLUMN fac_fire_drills.conducted_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020. The FM or fire warden who ran the drill.';


CREATE TABLE IF NOT EXISTS fac_asset_categories (
  id                             UUID PRIMARY KEY,
  school_id                      UUID NOT NULL,
  name                           TEXT NOT NULL,
  description                    TEXT,
  depreciation_years             INT,
  maintenance_interval_months    INT,
  is_active                      BOOLEAN NOT NULL DEFAULT true,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_asset_cat_depreciation_chk CHECK (
    depreciation_years IS NULL OR depreciation_years > 0
  ),
  CONSTRAINT fac_asset_cat_interval_chk CHECK (
    maintenance_interval_months IS NULL OR maintenance_interval_months > 0
  ),
  CONSTRAINT fac_asset_cat_uq UNIQUE (school_id, name)
);

CREATE INDEX IF NOT EXISTS fac_asset_cat_school_active_idx
  ON fac_asset_categories (school_id, is_active);

COMMENT ON TABLE fac_asset_categories IS
  'Per-school catalogue of asset categories (HVAC Electrical Plumbing Elevator Fire Safety and so on). depreciation_years configures the straight-line replacement projection. maintenance_interval_months drives the default scheduled-maintenance cadence — assets in this category inherit the interval unless overridden at the asset row. UNIQUE(school_id, name). is_active=false soft-deactivates a retired category while preserving historical assets.';


CREATE TABLE IF NOT EXISTS fac_assets (
  id                             UUID PRIMARY KEY,
  school_id                      UUID NOT NULL,
  category_id                    UUID NOT NULL,
  building_id                    UUID NOT NULL,
  space_id                       UUID,
  name                           TEXT NOT NULL,
  make                           TEXT,
  model                          TEXT,
  serial_number                  TEXT,
  install_date                   DATE,
  warranty_expiry                DATE,
  expected_lifespan_years        INT,
  replacement_cost_estimate      NUMERIC(10,2),
  replacement_priority           TEXT,
  status                         TEXT NOT NULL DEFAULT 'ACTIVE',
  notes                          TEXT,
  decommissioned_at              TIMESTAMPTZ,
  decommissioned_by              UUID,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_asset_priority_chk CHECK (
    replacement_priority IS NULL OR replacement_priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')
  ),
  CONSTRAINT fac_asset_status_chk CHECK (
    status IN ('ACTIVE', 'UNDER_MAINTENANCE', 'DECOMMISSIONED')
  ),
  CONSTRAINT fac_asset_lifespan_chk CHECK (
    expected_lifespan_years IS NULL OR expected_lifespan_years > 0
  ),
  CONSTRAINT fac_asset_cost_chk CHECK (
    replacement_cost_estimate IS NULL OR replacement_cost_estimate >= 0
  ),
  CONSTRAINT fac_asset_decom_chk CHECK (
    (status <> 'DECOMMISSIONED' AND decommissioned_at IS NULL AND decommissioned_by IS NULL)
    OR (status = 'DECOMMISSIONED' AND decommissioned_at IS NOT NULL AND decommissioned_by IS NOT NULL)
  ),
  CONSTRAINT fac_asset_category_fk FOREIGN KEY (category_id)
    REFERENCES fac_asset_categories(id) ON DELETE RESTRICT,
  CONSTRAINT fac_asset_building_fk FOREIGN KEY (building_id)
    REFERENCES fac_buildings(id) ON DELETE RESTRICT,
  CONSTRAINT fac_asset_space_fk FOREIGN KEY (space_id)
    REFERENCES fac_spaces(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS fac_asset_serial_uq
  ON fac_assets (school_id, serial_number)
  WHERE serial_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS fac_asset_school_status_idx
  ON fac_assets (school_id, status);

CREATE INDEX IF NOT EXISTS fac_asset_building_idx
  ON fac_assets (building_id, status);

CREATE INDEX IF NOT EXISTS fac_asset_priority_idx
  ON fac_assets (school_id, replacement_priority)
  WHERE status = 'ACTIVE' AND replacement_priority IS NOT NULL;

COMMENT ON TABLE fac_assets IS
  'Individual facilities asset record. 3-value status CHECK (ACTIVE UNDER_MAINTENANCE DECOMMISSIONED) with multi-column decom_chk keeping decommissioned_at and decommissioned_by populated atomically with status=DECOMMISSIONED. 4-value replacement_priority CHECK (LOW MEDIUM HIGH CRITICAL). Partial UNIQUE on (school_id, serial_number) WHERE serial_number IS NOT NULL — serial-tracked assets cannot duplicate while serial-less consumables can layer freely. install_date plus expected_lifespan_years feed the replacement-planning dashboard which sorts approaching-end-of-life assets by replacement_priority. RESTRICT on category and building delete preserves history. SET NULL on space delete leaves the asset addressable when a space is retired.';

COMMENT ON COLUMN fac_assets.school_id IS
  'Soft FK to platform.schools(id) per ADR-001/020.';

COMMENT ON COLUMN fac_assets.decommissioned_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020. The FM or admin who flipped the asset to DECOMMISSIONED.';


CREATE TABLE IF NOT EXISTS fac_asset_maintenance_records (
  id                          UUID PRIMARY KEY,
  asset_id                    UUID NOT NULL,
  maintenance_type            TEXT NOT NULL,
  performed_date              DATE NOT NULL,
  performed_by                TEXT NOT NULL,
  cost                        NUMERIC(10,2),
  description                 TEXT NOT NULL,
  next_maintenance_date       DATE,
  created_by                  UUID NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_asset_maint_type_chk CHECK (
    maintenance_type IN ('SCHEDULED', 'CORRECTIVE', 'EMERGENCY', 'INSPECTION')
  ),
  CONSTRAINT fac_asset_maint_cost_chk CHECK (cost IS NULL OR cost >= 0),
  CONSTRAINT fac_asset_maint_next_chk CHECK (
    next_maintenance_date IS NULL OR next_maintenance_date >= performed_date
  ),
  CONSTRAINT fac_asset_maint_desc_chk CHECK (length(trim(description)) > 0),
  CONSTRAINT fac_asset_maint_asset_fk FOREIGN KEY (asset_id)
    REFERENCES fac_assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fac_asset_maint_asset_date_idx
  ON fac_asset_maintenance_records (asset_id, performed_date DESC);

CREATE INDEX IF NOT EXISTS fac_asset_maint_next_idx
  ON fac_asset_maintenance_records (next_maintenance_date)
  WHERE next_maintenance_date IS NOT NULL;

COMMENT ON TABLE fac_asset_maintenance_records IS
  'Per-asset maintenance log. 4-value maintenance_type CHECK (SCHEDULED CORRECTIVE EMERGENCY INSPECTION). performed_by is free-form text — internal employees or third-party vendor names alike. cost when set is non-negative. next_maintenance_date when populated drives the overdue-maintenance dashboard: the service flags assets whose most-recent record has next_maintenance_date strictly less than today. CASCADE on asset delete since records are meaningless without their asset (and assets do not get hard-deleted post-DECOMMISSIONED — the disposal record holds the audit chain).';

COMMENT ON COLUMN fac_asset_maintenance_records.created_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020. The FM or admin who logged the maintenance.';


CREATE TABLE IF NOT EXISTS fac_asset_disposals (
  id                          UUID PRIMARY KEY,
  school_id                   UUID NOT NULL,
  asset_id                    UUID NOT NULL,
  disposal_method             TEXT NOT NULL,
  disposal_date               DATE NOT NULL,
  value_recovered             NUMERIC(10,2),
  recipient_name              TEXT,
  disposed_by                 UUID NOT NULL,
  authorised_by               UUID NOT NULL,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_asset_disp_method_chk CHECK (
    disposal_method IN ('AUCTION', 'DONATION', 'SKIP', 'TRADE_IN', 'SCRAP', 'TRANSFER')
  ),
  CONSTRAINT fac_asset_disp_value_chk CHECK (
    value_recovered IS NULL OR value_recovered >= 0
  ),
  CONSTRAINT fac_asset_disp_asset_uq UNIQUE (asset_id),
  CONSTRAINT fac_asset_disp_asset_fk FOREIGN KEY (asset_id)
    REFERENCES fac_assets(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS fac_asset_disp_school_date_idx
  ON fac_asset_disposals (school_id, disposal_date DESC);

COMMENT ON TABLE fac_asset_disposals IS
  'Per-asset disposal record. UNIQUE on asset_id so each asset can be disposed at most once — the schema-side belt-and-braces against double-dispose under concurrent admin actions. 6-value disposal_method CHECK (AUCTION DONATION SKIP TRADE_IN SCRAP TRANSFER). value_recovered when set is non-negative. RESTRICT on asset delete preserves the disposal audit. SAFETY KEYSTONE — the AssetService.dispose path refuses to create a row unless the parent fac_assets row has status=DECOMMISSIONED. The cross-row invariant lives at the service layer (matching Cycle 6 invoice cancel-and-refund) since CHECKs cannot reach across table boundaries.';

COMMENT ON COLUMN fac_asset_disposals.school_id IS
  'Soft FK to platform.schools(id) per ADR-001/020.';

COMMENT ON COLUMN fac_asset_disposals.disposed_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020. The FM who carried out the disposal.';

COMMENT ON COLUMN fac_asset_disposals.authorised_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020. The admin or finance officer who signed off on the disposal — separation-of-duties from the disposer.';


CREATE TABLE IF NOT EXISTS fac_utility_meters (
  id                          UUID PRIMARY KEY,
  school_id                   UUID NOT NULL,
  building_id                 UUID NOT NULL,
  meter_name                  TEXT NOT NULL,
  utility_type                TEXT NOT NULL,
  meter_reference             TEXT,
  unit                        TEXT NOT NULL,
  is_active                   BOOLEAN NOT NULL DEFAULT true,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_meter_type_chk CHECK (
    utility_type IN ('ELECTRICITY', 'GAS', 'WATER', 'HEATING_OIL', 'SOLAR')
  ),
  CONSTRAINT fac_meter_unit_chk CHECK (length(trim(unit)) > 0),
  CONSTRAINT fac_meter_name_uq UNIQUE (school_id, meter_name),
  CONSTRAINT fac_meter_building_fk FOREIGN KEY (building_id)
    REFERENCES fac_buildings(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS fac_meter_school_type_idx
  ON fac_utility_meters (school_id, utility_type) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS fac_meter_building_idx
  ON fac_utility_meters (building_id, utility_type);

COMMENT ON TABLE fac_utility_meters IS
  'Per-(building meter_name) utility meter. 5-value utility_type CHECK (ELECTRICITY GAS WATER HEATING_OIL SOLAR). unit is free-form (kWh therms gallons litres cubic metres) — set at creation and rendered verbatim by the dashboard. is_active=false soft-deactivates a retired meter while preserving historical readings. UNIQUE on (school_id, meter_name). RESTRICT on building delete.';

COMMENT ON COLUMN fac_utility_meters.school_id IS
  'Soft FK to platform.schools(id) per ADR-001/020.';


CREATE TABLE IF NOT EXISTS fac_energy_readings (
  id                          UUID PRIMARY KEY,
  meter_id                    UUID NOT NULL,
  reading_date                DATE NOT NULL,
  reading_value               NUMERIC(12,2) NOT NULL,
  consumption                 NUMERIC(10,2),
  cost_estimate               NUMERIC(10,2),
  recorded_by                 UUID NOT NULL,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_energy_value_chk CHECK (reading_value >= 0),
  CONSTRAINT fac_energy_cost_chk CHECK (cost_estimate IS NULL OR cost_estimate >= 0),
  CONSTRAINT fac_energy_uq UNIQUE (meter_id, reading_date),
  CONSTRAINT fac_energy_meter_fk FOREIGN KEY (meter_id)
    REFERENCES fac_utility_meters(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fac_energy_meter_date_idx
  ON fac_energy_readings (meter_id, reading_date DESC);

COMMENT ON TABLE fac_energy_readings IS
  'Per-(meter reading_date) raw reading. KEYSTONE — consumption is auto-computed at insert time by the EnergyService.recordReading as (current.reading_value minus the most-recent earlier reading_value on the same meter) so the dashboard can SUM a window without a window function. NULL consumption on the first reading per meter since there is no prior row to subtract. UNIQUE on (meter_id, reading_date) caps one reading per meter per day — re-reads should go through admin correction rather than a duplicate row. CASCADE on meter delete since readings without their meter are meaningless.';

COMMENT ON COLUMN fac_energy_readings.recorded_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020. The custodian or admin who recorded the reading.';


CREATE TABLE IF NOT EXISTS fac_energy_targets (
  id                          UUID PRIMARY KEY,
  school_id                   UUID NOT NULL,
  utility_type                TEXT NOT NULL,
  target_period               TEXT NOT NULL,
  target_value                NUMERIC(12,2) NOT NULL,
  academic_year               TEXT,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_energy_target_type_chk CHECK (
    utility_type IN ('ELECTRICITY', 'GAS', 'WATER', 'HEATING_OIL', 'SOLAR')
  ),
  CONSTRAINT fac_energy_target_period_chk CHECK (
    target_period IN ('MONTHLY', 'ANNUAL')
  ),
  CONSTRAINT fac_energy_target_value_chk CHECK (target_value > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS fac_energy_target_uq
  ON fac_energy_targets (school_id, utility_type, target_period, COALESCE(academic_year, ''));

CREATE INDEX IF NOT EXISTS fac_energy_target_lookup_idx
  ON fac_energy_targets (school_id, utility_type);

COMMENT ON TABLE fac_energy_targets IS
  'Per-(school utility_type target_period academic_year) consumption baseline. 2-value target_period CHECK (MONTHLY ANNUAL). UNIQUE with COALESCE-sentinel on academic_year so a row with NULL academic_year (rolling baseline) coexists with named-year overrides — same sentinel pattern as Cycle 5 sch_periods, Cycle 6 enr_intake_capacities, and Cycle 12 lib_reading_lists. target_value strictly positive — zero or negative targets are operator error.';

COMMENT ON COLUMN fac_energy_targets.school_id IS
  'Soft FK to platform.schools(id) per ADR-001/020.';


CREATE TABLE IF NOT EXISTS fac_space_utilization_records (
  id                          UUID PRIMARY KEY,
  space_id                    UUID NOT NULL,
  record_date                 DATE NOT NULL,
  period_id                   UUID,
  occupancy_count             INT NOT NULL,
  capacity                    INT NOT NULL,
  utilisation_rate            NUMERIC(5,4),
  source                      TEXT NOT NULL DEFAULT 'MANUAL',
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_space_util_occ_chk CHECK (occupancy_count >= 0),
  CONSTRAINT fac_space_util_cap_chk CHECK (capacity >= 0),
  CONSTRAINT fac_space_util_rate_chk CHECK (
    utilisation_rate IS NULL OR (utilisation_rate >= 0 AND utilisation_rate <= 1)
  ),
  CONSTRAINT fac_space_util_source_chk CHECK (
    source IN ('MANUAL', 'ATTENDANCE', 'BOOKING', 'SENSOR')
  ),
  CONSTRAINT fac_space_util_space_fk FOREIGN KEY (space_id)
    REFERENCES fac_spaces(id) ON DELETE CASCADE,
  CONSTRAINT fac_space_util_period_fk FOREIGN KEY (period_id)
    REFERENCES sch_periods(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS fac_space_util_uq
  ON fac_space_utilization_records (
    space_id,
    record_date,
    COALESCE(period_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS fac_space_util_date_idx
  ON fac_space_utilization_records (record_date DESC, space_id);

CREATE INDEX IF NOT EXISTS fac_space_util_rate_idx
  ON fac_space_utilization_records (space_id, record_date DESC)
  WHERE utilisation_rate IS NOT NULL AND utilisation_rate < 0.5;

COMMENT ON TABLE fac_space_utilization_records IS
  'Per-(space record_date period) occupancy snapshot. occupancy_count and capacity non-negative. utilisation_rate is the materialised (occupancy / capacity) ratio so the underused-space dashboard can filter without division-by-zero juggling — NULL when capacity is zero. UNIQUE on (space_id, record_date, COALESCE(period_id, sentinel)) lets a daily aggregate row (period_id NULL) coexist with per-period breakdowns. 4-value source CHECK identifies the populating workflow (MANUAL ATTENDANCE BOOKING SENSOR). The partial low-utilisation INDEX is the hot path for the Step 4 underused-rooms query. CASCADE on space delete. SET NULL on period delete preserves the snapshot.';


CREATE TABLE IF NOT EXISTS fac_sustainability_initiatives (
  id                          UUID PRIMARY KEY,
  school_id                   UUID NOT NULL,
  name                        TEXT NOT NULL,
  description                 TEXT,
  category                    TEXT NOT NULL,
  start_date                  DATE NOT NULL,
  target_completion_date      DATE,
  target_reduction_percent    NUMERIC(5,2),
  status                      TEXT NOT NULL DEFAULT 'ACTIVE',
  outcome_notes               TEXT,
  created_by                  UUID NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fac_sust_category_chk CHECK (
    category IN ('ENERGY', 'WATER', 'WASTE', 'TRANSPORT', 'BIODIVERSITY')
  ),
  CONSTRAINT fac_sust_status_chk CHECK (
    status IN ('ACTIVE', 'COMPLETED', 'CANCELLED')
  ),
  CONSTRAINT fac_sust_reduction_chk CHECK (
    target_reduction_percent IS NULL OR (target_reduction_percent >= 0 AND target_reduction_percent <= 100)
  ),
  CONSTRAINT fac_sust_dates_chk CHECK (
    target_completion_date IS NULL OR target_completion_date >= start_date
  ),
  CONSTRAINT fac_sust_uq UNIQUE (school_id, name)
);

CREATE INDEX IF NOT EXISTS fac_sust_school_status_idx
  ON fac_sustainability_initiatives (school_id, status, start_date DESC);

COMMENT ON TABLE fac_sustainability_initiatives IS
  'Per-school sustainability program. 5-value category CHECK (ENERGY WATER WASTE TRANSPORT BIODIVERSITY). 3-value status CHECK (ACTIVE COMPLETED CANCELLED). target_reduction_percent when set is bounded 0..100. UNIQUE(school_id, name) so the initiative name doubles as a stable handle in dashboard references.';

COMMENT ON COLUMN fac_sustainability_initiatives.school_id IS
  'Soft FK to platform.schools(id) per ADR-001/020.';

COMMENT ON COLUMN fac_sustainability_initiatives.created_by IS
  'Soft FK to platform.iam_person(id) per ADR-001/020. The FM who launched the initiative.';
