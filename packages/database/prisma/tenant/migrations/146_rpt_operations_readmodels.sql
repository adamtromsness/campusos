/*
  P2-15a Step 1 — Operations Read Models Schema (M110 Analytics .1, ADR-008 CQRS-lite, ADR-049)

  Nine domain-specific materialised read models for operational modules
  built across Phases 1 and 2. Each table is the single-writer surface
  for exactly one Kafka consumer worker — source modules never write to
  or read from rpt_* tables (CI enforced). All reads route to the read
  replica. Every worker uses INSERT ON CONFLICT DO UPDATE on the
  documented UNIQUE constraint so replaying the same event produces the
  same row, and every worker records its committed Kafka offset to
  rpt_analytics_worker_checkpoints.

  Tables in this migration:

   - rpt_procurement_summary       — prc.po.issued + prc.receipt.completed
   - rpt_store_sales               — str.order.completed
   - rpt_fds_meal_counts           — fds.meal.served (daily per meal type)
   - rpt_fds_nslp_summary          — fds.meal.served (monthly federal NSLP)
   - rpt_trn_ridership_summary     — trn.run.completed
   - rpt_facilities_condition      — fac.inspection.completed and fac.work_order.completed
   - rpt_facilities_kpi            — fac.work_order.* and fac.energy.* (nightly batch only)
   - rpt_tech_fleet_status         — tech.device.provisioned, deprovisioned, incident
   - rpt_lib_circulation_summary   — lib.checkout.created + lib.return.completed

  Period columns are stored as DATE anchored at the first day of the
  month for monthly grain, the actual service_date for daily grain. JSONB
  is used for popular_titles top-10 lists. No cross-schema FKs. school_id
  is a soft ref to platform.schools per ADR-001/020.

  Splitter discipline: every comment is a block comment. Statement chunks
  must not contain a stray semicolon inside string literals or COMMENT ON
  bodies, since the splitter cuts on every semicolon regardless of
  quoting context.
*/

/* ========================================================================
   1. rpt_procurement_summary
   Source: prc.po.issued, prc.receipt.completed
   Owner:  ProcurementReadModelWorker
   ====================================================================== */
CREATE TABLE IF NOT EXISTS rpt_procurement_summary (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  period DATE NOT NULL,
  department TEXT NOT NULL DEFAULT 'UNKNOWN',
  vendor_id UUID NOT NULL,
  total_pos INT NOT NULL DEFAULT 0,
  total_spend NUMERIC(14,2) NOT NULL DEFAULT 0,
  avg_lead_time_days NUMERIC(8,2),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_procurement_total_pos_chk CHECK (total_pos >= 0),
  CONSTRAINT rpt_procurement_total_spend_chk CHECK (total_spend >= 0),
  CONSTRAINT rpt_procurement_lead_chk CHECK (avg_lead_time_days IS NULL OR avg_lead_time_days >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_procurement_summary_uq
  ON rpt_procurement_summary (school_id, period, department, vendor_id);

CREATE INDEX IF NOT EXISTS rpt_procurement_summary_school_period_idx
  ON rpt_procurement_summary (school_id, period DESC);

COMMENT ON TABLE rpt_procurement_summary IS
  'Per-(school, period, department, vendor) procurement rollup. Written exclusively by ProcurementReadModelWorker consuming prc.po.issued and prc.receipt.completed. UPSERT-idempotent on the UNIQUE constraint.';

COMMENT ON COLUMN rpt_procurement_summary.period IS
  'First day of the month (DATE truncated to month). Anchors the monthly grain.';

COMMENT ON COLUMN rpt_procurement_summary.avg_lead_time_days IS
  'Average days between PO issued and receipt completed within the period. NULL until at least one matching receipt lands.';


/* ========================================================================
   2. rpt_store_sales
   Source: str.order.completed
   Owner:  StoreReadModelWorker
   ====================================================================== */
CREATE TABLE IF NOT EXISTS rpt_store_sales (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  period DATE NOT NULL,
  product_id UUID NOT NULL,
  units_sold INT NOT NULL DEFAULT 0,
  revenue NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost_of_goods NUMERIC(14,2) NOT NULL DEFAULT 0,
  profit_margin NUMERIC(6,4),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_store_sales_units_chk CHECK (units_sold >= 0),
  CONSTRAINT rpt_store_sales_revenue_chk CHECK (revenue >= 0),
  CONSTRAINT rpt_store_sales_cogs_chk CHECK (cost_of_goods >= 0),
  CONSTRAINT rpt_store_sales_margin_chk CHECK (profit_margin IS NULL OR (profit_margin >= -1 AND profit_margin <= 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_store_sales_uq
  ON rpt_store_sales (school_id, period, product_id);

CREATE INDEX IF NOT EXISTS rpt_store_sales_school_period_idx
  ON rpt_store_sales (school_id, period DESC);

COMMENT ON TABLE rpt_store_sales IS
  'Per-(school, period, product) store sales rollup. Written exclusively by StoreReadModelWorker consuming str.order.completed. profit_margin = (revenue - cost_of_goods) / revenue when revenue > 0.';


/* ========================================================================
   3. rpt_fds_meal_counts
   Source: fds.meal.served
   Owner:  FoodServiceReadModelWorker (writes here and to rpt_fds_nslp_summary)
   ====================================================================== */
CREATE TABLE IF NOT EXISTS rpt_fds_meal_counts (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  service_date DATE NOT NULL,
  meal_type TEXT NOT NULL,
  total_served INT NOT NULL DEFAULT 0,
  free_count INT NOT NULL DEFAULT 0,
  reduced_count INT NOT NULL DEFAULT 0,
  paid_count INT NOT NULL DEFAULT 0,
  waste_count INT NOT NULL DEFAULT 0,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_fds_meal_type_chk CHECK (meal_type IN ('BREAKFAST','LUNCH','SNACK','SUPPER')),
  CONSTRAINT rpt_fds_meal_total_chk CHECK (total_served >= 0),
  CONSTRAINT rpt_fds_meal_free_chk CHECK (free_count >= 0),
  CONSTRAINT rpt_fds_meal_reduced_chk CHECK (reduced_count >= 0),
  CONSTRAINT rpt_fds_meal_paid_chk CHECK (paid_count >= 0),
  CONSTRAINT rpt_fds_meal_waste_chk CHECK (waste_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_fds_meal_counts_uq
  ON rpt_fds_meal_counts (school_id, service_date, meal_type);

CREATE INDEX IF NOT EXISTS rpt_fds_meal_counts_school_date_idx
  ON rpt_fds_meal_counts (school_id, service_date DESC);

COMMENT ON TABLE rpt_fds_meal_counts IS
  'Per-(school, service_date, meal_type) meal count rollup. Written exclusively by FoodServiceReadModelWorker consuming fds.meal.served. Daily grain so plotting meal trends is one query.';


/* ========================================================================
   4. rpt_fds_nslp_summary
   Source: fds.meal.served + eligibility changes (monthly federal grain)
   Owner:  FoodServiceReadModelWorker
   ====================================================================== */
CREATE TABLE IF NOT EXISTS rpt_fds_nslp_summary (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  month_year DATE NOT NULL,
  free_meals INT NOT NULL DEFAULT 0,
  reduced_meals INT NOT NULL DEFAULT 0,
  paid_meals INT NOT NULL DEFAULT 0,
  total_reimbursement_estimate NUMERIC(14,2) NOT NULL DEFAULT 0,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_fds_nslp_free_chk CHECK (free_meals >= 0),
  CONSTRAINT rpt_fds_nslp_reduced_chk CHECK (reduced_meals >= 0),
  CONSTRAINT rpt_fds_nslp_paid_chk CHECK (paid_meals >= 0),
  CONSTRAINT rpt_fds_nslp_reimb_chk CHECK (total_reimbursement_estimate >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_fds_nslp_summary_uq
  ON rpt_fds_nslp_summary (school_id, month_year);

COMMENT ON TABLE rpt_fds_nslp_summary IS
  'Federal compliance reporting surface — per-(school, month_year) NSLP rollup. Written exclusively by FoodServiceReadModelWorker. month_year is the first day of the month (DATE truncated to month).';


/* ========================================================================
   5. rpt_trn_ridership_summary
   Source: trn.run.completed
   Owner:  TransportReadModelWorker
   ====================================================================== */
CREATE TABLE IF NOT EXISTS rpt_trn_ridership_summary (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  route_id UUID NOT NULL,
  period DATE NOT NULL,
  total_runs INT NOT NULL DEFAULT 0,
  total_riders INT NOT NULL DEFAULT 0,
  avg_riders_per_run NUMERIC(8,2),
  on_time_rate NUMERIC(5,4),
  avg_duration_minutes NUMERIC(8,2),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_trn_runs_chk CHECK (total_runs >= 0),
  CONSTRAINT rpt_trn_riders_chk CHECK (total_riders >= 0),
  CONSTRAINT rpt_trn_avg_riders_chk CHECK (avg_riders_per_run IS NULL OR avg_riders_per_run >= 0),
  CONSTRAINT rpt_trn_ontime_chk CHECK (on_time_rate IS NULL OR (on_time_rate >= 0 AND on_time_rate <= 1)),
  CONSTRAINT rpt_trn_duration_chk CHECK (avg_duration_minutes IS NULL OR avg_duration_minutes >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_trn_ridership_summary_uq
  ON rpt_trn_ridership_summary (school_id, route_id, period);

CREATE INDEX IF NOT EXISTS rpt_trn_ridership_school_period_idx
  ON rpt_trn_ridership_summary (school_id, period DESC);

COMMENT ON TABLE rpt_trn_ridership_summary IS
  'Per-(school, route, period) transportation ridership rollup. Written exclusively by TransportReadModelWorker consuming trn.run.completed. period is the first day of the month.';


/* ========================================================================
   6. rpt_facilities_condition
   Source: fac.inspection.completed, fac.work_order.completed
   Owner:  FacilitiesReadModelWorker
   ====================================================================== */
CREATE TABLE IF NOT EXISTS rpt_facilities_condition (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  building_id UUID NOT NULL,
  space_id UUID NOT NULL,
  last_inspection_date DATE,
  condition_score NUMERIC(3,1),
  open_work_orders INT NOT NULL DEFAULT 0,
  overdue_work_orders INT NOT NULL DEFAULT 0,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_fac_condition_score_chk CHECK (condition_score IS NULL OR (condition_score >= 0 AND condition_score <= 10)),
  CONSTRAINT rpt_fac_open_wo_chk CHECK (open_work_orders >= 0),
  CONSTRAINT rpt_fac_overdue_wo_chk CHECK (overdue_work_orders >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_facilities_condition_uq
  ON rpt_facilities_condition (school_id, building_id, space_id);

CREATE INDEX IF NOT EXISTS rpt_facilities_condition_school_idx
  ON rpt_facilities_condition (school_id);

COMMENT ON TABLE rpt_facilities_condition IS
  'Per-(school, building, space) current condition + open work order rollup. Written exclusively by FacilitiesReadModelWorker consuming fac.inspection.completed and fac.work_order.completed events. condition_score is 0.0 to 10.0.';


/* ========================================================================
   7. rpt_facilities_kpi
   Source: fac.work_order.created/completed + fac.energy.* (NIGHTLY BATCH)
   Owner:  FacilitiesReadModelWorker.materialiseKpi()
   ====================================================================== */
CREATE TABLE IF NOT EXISTS rpt_facilities_kpi (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  period DATE NOT NULL,
  total_work_orders INT NOT NULL DEFAULT 0,
  completed_on_time INT NOT NULL DEFAULT 0,
  avg_resolution_days NUMERIC(8,2),
  energy_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost_per_sqft NUMERIC(10,4),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_fac_kpi_total_chk CHECK (total_work_orders >= 0),
  CONSTRAINT rpt_fac_kpi_ontime_chk CHECK (completed_on_time >= 0),
  CONSTRAINT rpt_fac_kpi_resolution_chk CHECK (avg_resolution_days IS NULL OR avg_resolution_days >= 0),
  CONSTRAINT rpt_fac_kpi_energy_chk CHECK (energy_cost >= 0),
  CONSTRAINT rpt_fac_kpi_costsqft_chk CHECK (cost_per_sqft IS NULL OR cost_per_sqft >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_facilities_kpi_uq
  ON rpt_facilities_kpi (school_id, period);

COMMENT ON TABLE rpt_facilities_kpi IS
  'Per-(school, period) facilities KPI rollup. NIGHTLY BATCH materialisation by FacilitiesReadModelWorker.materialiseKpi() — not a live consumer. period is the first day of the month.';


/* ========================================================================
   8. rpt_tech_fleet_status
   Source: tech.device.provisioned, tech.device.deprovisioned, tech.device.incident
   Owner:  ITReadModelWorker
   ====================================================================== */
CREATE TABLE IF NOT EXISTS rpt_tech_fleet_status (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  device_type TEXT NOT NULL,
  total_devices INT NOT NULL DEFAULT 0,
  active INT NOT NULL DEFAULT 0,
  in_repair INT NOT NULL DEFAULT 0,
  decommissioned INT NOT NULL DEFAULT 0,
  avg_age_months NUMERIC(8,2),
  incident_rate NUMERIC(6,4),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_tech_total_chk CHECK (total_devices >= 0),
  CONSTRAINT rpt_tech_active_chk CHECK (active >= 0),
  CONSTRAINT rpt_tech_repair_chk CHECK (in_repair >= 0),
  CONSTRAINT rpt_tech_decom_chk CHECK (decommissioned >= 0),
  CONSTRAINT rpt_tech_age_chk CHECK (avg_age_months IS NULL OR avg_age_months >= 0),
  CONSTRAINT rpt_tech_incident_rate_chk CHECK (incident_rate IS NULL OR (incident_rate >= 0 AND incident_rate <= 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_tech_fleet_status_uq
  ON rpt_tech_fleet_status (school_id, device_type);

COMMENT ON TABLE rpt_tech_fleet_status IS
  'Per-(school, device_type) IT fleet status rollup. Written exclusively by ITReadModelWorker consuming tech.device.* events. incident_rate is incidents per device.';


/* ========================================================================
   9. rpt_lib_circulation_summary
   Source: lib.checkout.created, lib.return.completed
   Owner:  LibraryReadModelWorker
   ====================================================================== */
CREATE TABLE IF NOT EXISTS rpt_lib_circulation_summary (
  id UUID PRIMARY KEY,
  school_id UUID NOT NULL,
  period DATE NOT NULL,
  total_checkouts INT NOT NULL DEFAULT 0,
  total_returns INT NOT NULL DEFAULT 0,
  overdue_count INT NOT NULL DEFAULT 0,
  popular_titles JSONB NOT NULL DEFAULT '[]'::jsonb,
  avg_loan_duration_days NUMERIC(8,2),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rpt_lib_checkouts_chk CHECK (total_checkouts >= 0),
  CONSTRAINT rpt_lib_returns_chk CHECK (total_returns >= 0),
  CONSTRAINT rpt_lib_overdue_chk CHECK (overdue_count >= 0),
  CONSTRAINT rpt_lib_loan_chk CHECK (avg_loan_duration_days IS NULL OR avg_loan_duration_days >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rpt_lib_circulation_summary_uq
  ON rpt_lib_circulation_summary (school_id, period);

COMMENT ON TABLE rpt_lib_circulation_summary IS
  'Per-(school, period) library circulation rollup. Written exclusively by LibraryReadModelWorker consuming lib.checkout.created and lib.return.completed. popular_titles JSONB holds the top-10 borrowed titles for the period.';
