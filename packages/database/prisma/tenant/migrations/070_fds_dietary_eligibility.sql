/*
 * 070_fds_dietary_eligibility.sql — Cycle 20 Step 3.
 *
 * M63 Food Service domain 3: student dietary profiles, the
 * health-to-food allergen read model (ADR-030), parent dietary change
 * requests, NSLP eligibility applications and determinations, USDA
 * monthly reimbursement claims, food safety temperature logs (HACCP),
 * and USDA production records.
 *
 * fds_student_allergen_alerts is the SAFETY KEYSTONE read model. It
 * mirrors hlth_health_alerts (Cycle 10) via a future Kafka consumer
 * subscribing to hlth.allergy_alert.changed (deferred to Phase 2 per
 * the plan). This cycle ships the schema + seed + a manual sync
 * admin endpoint that reads hlth_health_alerts directly and upserts
 * the read model. Food Service code never reads hlth_* tables on the
 * request path.
 *
 * No semicolons inside string literals or block comments.
 */

CREATE TABLE IF NOT EXISTS fds_student_dietary_profiles (
  id                      UUID PRIMARY KEY,
  student_id              UUID NOT NULL UNIQUE,
  school_id               UUID NOT NULL,
  dietary_restrictions    TEXT[] NOT NULL DEFAULT '{}',
  allergens               TEXT[] NOT NULL DEFAULT '{}',
  free_meal_eligible      BOOLEAN NOT NULL DEFAULT false,
  meal_plan_type          TEXT NOT NULL DEFAULT 'STANDARD',
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_diet_plan_chk CHECK (
    meal_plan_type IN ('STANDARD', 'VEGETARIAN', 'VEGAN', 'HALAL', 'KOSHER', 'OTHER')
  )
);

CREATE INDEX IF NOT EXISTS fds_diet_school_idx
  ON fds_student_dietary_profiles (school_id);

COMMENT ON TABLE fds_student_dietary_profiles IS
  'Per-student dietary profile. UNIQUE on student_id keeps the row 1-to-1 with the student. allergens TEXT[] here is preference-based display only. POS safety enforcement reads from fds_student_allergen_alerts which mirrors hlth_health_alerts via the ADR-030 read model pattern. free_meal_eligible mirrors the most recent NSLP determination.';

CREATE TABLE IF NOT EXISTS fds_student_allergen_alerts (
  id                          UUID PRIMARY KEY,
  student_id                  UUID NOT NULL,
  school_id                   UUID NOT NULL,
  allergen_code               TEXT NOT NULL,
  allergen_display_name       TEXT NOT NULL,
  severity                    TEXT NOT NULL,
  source_health_alert_id      UUID NOT NULL,
  is_active                   BOOLEAN NOT NULL DEFAULT true,
  last_synced_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_alert_severity_chk CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL'))
);

CREATE UNIQUE INDEX IF NOT EXISTS fds_alert_active_uq
  ON fds_student_allergen_alerts (student_id, allergen_code)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS fds_alert_student_active_idx
  ON fds_student_allergen_alerts (student_id, is_active);

CREATE INDEX IF NOT EXISTS fds_alert_school_code_idx
  ON fds_student_allergen_alerts (school_id, allergen_code)
  WHERE is_active = true;

COMMENT ON TABLE fds_student_allergen_alerts IS
  'SAFETY KEYSTONE read model populated by the future Cycle-10 Kafka consumer (hlth.allergy_alert.changed). 3-value severity CHECK pins INFO / WARNING / CRITICAL. CRITICAL matches at the POS BLOCK the transaction unless supervisor_override_id is supplied. Partial UNIQUE(student, allergen) WHERE is_active=true caps to one active row per (student, allergen). source_health_alert_id is a soft polymorphic ref to hlth_health_alerts and the consumer upserts on this column to keep the mirror deterministic.';

CREATE TABLE IF NOT EXISTS fds_dietary_update_requests (
  id              UUID PRIMARY KEY,
  school_id       UUID NOT NULL,
  submitted_by    UUID NOT NULL,
  student_id      UUID NOT NULL,
  change_type     TEXT NOT NULL,
  proposed_value  TEXT NOT NULL,
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'PENDING',
  reviewed_by     UUID,
  reviewed_at     TIMESTAMPTZ,
  review_notes    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_dur_type_chk CHECK (
    change_type IN (
      'ADD_RESTRICTION', 'REMOVE_RESTRICTION',
      'ADD_ALLERGEN', 'REMOVE_ALLERGEN',
      'CHANGE_MEAL_PLAN', 'UPDATE_ELIGIBILITY'
    )
  ),
  CONSTRAINT fds_dur_status_chk CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  CONSTRAINT fds_dur_reviewed_chk CHECK (
    (status = 'PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (status IN ('APPROVED', 'REJECTED') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS fds_dur_pending_idx
  ON fds_dietary_update_requests (school_id, status)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS fds_dur_student_idx
  ON fds_dietary_update_requests (student_id, created_at DESC);

COMMENT ON TABLE fds_dietary_update_requests IS
  'Parent-submitted dietary change request. 6-value change_type CHECK + 3-value status CHECK. Multi-column reviewed_chk lockstep keeps reviewed_by + reviewed_at consistent with non-PENDING statuses. The Step 7 service applies APPROVED requests to fds_student_dietary_profiles inside the same tenant tx that flips the status.';

CREATE TABLE IF NOT EXISTS fds_eligibility_applications (
  id                          UUID PRIMARY KEY,
  school_id                   UUID NOT NULL,
  student_id                  UUID NOT NULL,
  submitted_by                UUID NOT NULL,
  academic_year_id            UUID,
  household_size              INT NOT NULL,
  annual_household_income     NUMERIC(10,2),
  snap_benefit_case_number    TEXT,
  application_type            TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'SUBMITTED',
  submitted_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_app_size_chk CHECK (household_size > 0),
  CONSTRAINT fds_app_income_chk CHECK (
    annual_household_income IS NULL OR annual_household_income >= 0
  ),
  CONSTRAINT fds_app_type_chk CHECK (
    application_type IN ('INCOME_BASED', 'CATEGORICAL', 'DIRECT_CERTIFICATION')
  ),
  CONSTRAINT fds_app_status_chk CHECK (
    status IN ('SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'DENIED', 'WITHDRAWN')
  )
);

CREATE INDEX IF NOT EXISTS fds_app_school_status_idx
  ON fds_eligibility_applications (school_id, academic_year_id, status);

COMMENT ON TABLE fds_eligibility_applications IS
  'NSLP free / reduced price meal application. 3-value application_type CHECK + 5-value status CHECK. annual_household_income is plain text in this cycle — encryption-at-rest is a Phase 2 ops concern per the plan.';

CREATE TABLE IF NOT EXISTS fds_eligibility_determinations (
  id                      UUID PRIMARY KEY,
  application_id          UUID NOT NULL UNIQUE,
  determined_by           UUID NOT NULL,
  determined_at           DATE NOT NULL DEFAULT CURRENT_DATE,
  eligibility_category    TEXT NOT NULL,
  effective_from          DATE NOT NULL,
  effective_to            DATE NOT NULL,
  notification_sent       BOOLEAN NOT NULL DEFAULT false,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_det_category_chk CHECK (
    eligibility_category IN ('FREE', 'REDUCED', 'PAID', 'DENIED')
  ),
  CONSTRAINT fds_det_effective_chk CHECK (effective_to >= effective_from),
  CONSTRAINT fds_det_app_fk FOREIGN KEY (application_id)
    REFERENCES fds_eligibility_applications(id) ON DELETE CASCADE
);

COMMENT ON TABLE fds_eligibility_determinations IS
  'Per-application determination outcome. UNIQUE(application_id) so each application has at most one determination. CASCADE on parent application. The Step 7 service auto-flips fds_student_dietary_profiles.free_meal_eligible to true when eligibility_category=FREE or REDUCED.';

CREATE TABLE IF NOT EXISTS fds_usda_reimbursement_claims (
  id                      UUID PRIMARY KEY,
  school_id               UUID NOT NULL,
  academic_year_id        UUID,
  month_year              DATE NOT NULL,
  free_meals_count        INT NOT NULL DEFAULT 0,
  reduced_meals_count     INT NOT NULL DEFAULT 0,
  paid_meals_count        INT NOT NULL DEFAULT 0,
  reimbursement_amount    NUMERIC(10,2),
  status                  TEXT NOT NULL DEFAULT 'DRAFT',
  submitted_by            UUID,
  submitted_at            TIMESTAMPTZ,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_claim_status_chk CHECK (
    status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED')
  ),
  CONSTRAINT fds_claim_counts_chk CHECK (
    free_meals_count >= 0 AND reduced_meals_count >= 0 AND paid_meals_count >= 0
  ),
  CONSTRAINT fds_claim_amount_chk CHECK (
    reimbursement_amount IS NULL OR reimbursement_amount >= 0
  ),
  CONSTRAINT fds_claim_uq UNIQUE (school_id, academic_year_id, month_year)
);

CREATE INDEX IF NOT EXISTS fds_claim_school_month_idx
  ON fds_usda_reimbursement_claims (school_id, month_year DESC);

COMMENT ON TABLE fds_usda_reimbursement_claims IS
  'Monthly USDA reimbursement claim. UNIQUE(school, year, month_year) caps to one claim per month per school per academic year. The Step 7 service aggregates meal counts from fds_meal_transactions filtered by payment_method and served_at month.';

CREATE TABLE IF NOT EXISTS fds_temperature_logs (
  id                  UUID PRIMARY KEY,
  school_id           UUID NOT NULL,
  check_location      TEXT NOT NULL,
  location_name       TEXT NOT NULL,
  temperature_celsius NUMERIC(4,1) NOT NULL,
  safe_range_min      NUMERIC(4,1) NOT NULL,
  safe_range_max      NUMERIC(4,1) NOT NULL,
  is_compliant        BOOLEAN NOT NULL,
  corrective_action   TEXT,
  logged_by           UUID NOT NULL,
  logged_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_temp_location_chk CHECK (
    check_location IN (
      'DELIVERY', 'REFRIGERATOR', 'FREEZER', 'SERVING_LINE',
      'HOT_HOLD', 'COLD_HOLD', 'COOK_TEMP'
    )
  ),
  CONSTRAINT fds_temp_range_chk CHECK (safe_range_max >= safe_range_min),
  CONSTRAINT fds_temp_corrective_chk CHECK (
    (is_compliant = true)
    OR (is_compliant = false AND corrective_action IS NOT NULL AND length(corrective_action) > 0)
  )
);

CREATE INDEX IF NOT EXISTS fds_temp_non_compliant_idx
  ON fds_temperature_logs (school_id, is_compliant, logged_at DESC)
  WHERE is_compliant = false;

CREATE INDEX IF NOT EXISTS fds_temp_school_logged_idx
  ON fds_temperature_logs (school_id, logged_at DESC);

COMMENT ON TABLE fds_temperature_logs IS
  'HACCP food safety temperature log. 7-value check_location CHECK covers every regulated surface. Multi-column corrective_chk requires a non-empty corrective_action when is_compliant=false. Partial INDEX on the non-compliant rows backs the Step 9 dashboard. Partition-ready RANGE(logged_at).';

CREATE TABLE IF NOT EXISTS fds_production_records (
  id                      UUID PRIMARY KEY,
  school_id               UUID NOT NULL,
  meal_service_date       DATE NOT NULL,
  meal_type               TEXT NOT NULL,
  menu_item_id            UUID NOT NULL,
  quantity_prepared       INT NOT NULL DEFAULT 0,
  quantity_served         INT NOT NULL DEFAULT 0,
  quantity_leftover       INT NOT NULL DEFAULT 0,
  quantity_wasted         INT NOT NULL DEFAULT 0,
  meets_meal_pattern      BOOLEAN NOT NULL DEFAULT false,
  notes                   TEXT,
  created_by              UUID NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fds_prod_meal_chk CHECK (
    meal_type IN ('BREAKFAST', 'LUNCH', 'DINNER', 'SNACK')
  ),
  CONSTRAINT fds_prod_counts_chk CHECK (
    quantity_prepared >= 0 AND quantity_served >= 0
    AND quantity_leftover >= 0 AND quantity_wasted >= 0
  ),
  CONSTRAINT fds_prod_uq UNIQUE (school_id, meal_service_date, meal_type, menu_item_id),
  CONSTRAINT fds_prod_item_fk FOREIGN KEY (menu_item_id)
    REFERENCES fds_menu_items(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS fds_prod_school_date_idx
  ON fds_production_records (school_id, meal_service_date DESC);

COMMENT ON TABLE fds_production_records IS
  'USDA meal pattern compliance documentation. UNIQUE(school, date, meal_type, item) caps to one row per slot. NO ACTION on menu_item_id preserves historical USDA audit when an item is retired.';
