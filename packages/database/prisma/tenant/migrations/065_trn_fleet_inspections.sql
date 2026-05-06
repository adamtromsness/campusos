/*
 * 065_trn_fleet_inspections.sql — Cycle 19 Step 2.
 *
 * M61 Transportation domain 2: vehicle fleet with registration
 * documents and expiry tracking, daily pre-trip safety inspections
 * with per-item pass or fail checklist, scheduled maintenance with
 * mileage and date drivers, and driver credential management with
 * CDL or medical or background check verification.
 *
 * Soft FKs to platform.iam_person and hr_employees per ADR-001 and
 * ADR-020 are not enforced at the schema level. Driver credentials
 * status is auto-computed by the Step 6 DriverCredentialService —
 * EXPIRING_SOON within 30 days, EXPIRED past expiry_date.
 *
 * No semicolons inside string literals or block comments.
 */

CREATE TABLE IF NOT EXISTS trn_vehicles (
  id                  UUID PRIMARY KEY,
  school_id           UUID NOT NULL,
  registration        TEXT NOT NULL,
  make                TEXT,
  model               TEXT,
  year                INT,
  capacity            INT NOT NULL,
  vehicle_type        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'ACTIVE',
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_vehicles_type_chk CHECK (vehicle_type IN ('BUS', 'MINIBUS', 'VAN')),
  CONSTRAINT trn_vehicles_status_chk CHECK (status IN ('ACTIVE', 'MAINTENANCE', 'RETIRED')),
  CONSTRAINT trn_vehicles_capacity_chk CHECK (capacity > 0),
  CONSTRAINT trn_vehicles_year_chk CHECK (year IS NULL OR year BETWEEN 1900 AND 2100),
  CONSTRAINT trn_vehicles_uq UNIQUE (school_id, registration)
);

CREATE INDEX IF NOT EXISTS trn_vehicles_school_status_idx
  ON trn_vehicles (school_id, status);

COMMENT ON TABLE trn_vehicles IS
  'Vehicle in the school fleet. 3-value vehicle_type CHECK and 3-value status CHECK. UNIQUE(school, registration) so the registration plate is unique per school. capacity > 0 keeps a zero-cap row from being inserted by mistake.';

CREATE TABLE IF NOT EXISTS trn_vehicle_documents (
  id              UUID PRIMARY KEY,
  vehicle_id      UUID NOT NULL,
  document_type   TEXT NOT NULL,
  document_number TEXT,
  s3_key          TEXT,
  issued_date     DATE,
  expiry_date     DATE NOT NULL,
  is_current      BOOLEAN NOT NULL DEFAULT true,
  uploaded_by     UUID,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes           TEXT,
  CONSTRAINT trn_vdocs_type_chk CHECK (
    document_type IN ('INSURANCE', 'REGISTRATION', 'MOT', 'INSPECTION')
  ),
  CONSTRAINT trn_vdocs_dates_chk CHECK (issued_date IS NULL OR expiry_date > issued_date),
  CONSTRAINT trn_vdocs_vehicle_fk FOREIGN KEY (vehicle_id)
    REFERENCES trn_vehicles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS trn_vdocs_vehicle_type_idx
  ON trn_vehicle_documents (vehicle_id, document_type, is_current);

COMMENT ON TABLE trn_vehicle_documents IS
  'Vehicle registration and insurance and MOT and inspection documents. 4-value document_type CHECK. is_current allows the TC to archive past versions while the document number trail stays auditable. INDEX(vehicle, type, is_current) backs the TC dashboard expiry alerts.';

CREATE TABLE IF NOT EXISTS trn_pre_trip_inspections (
  id              UUID PRIMARY KEY,
  vehicle_id      UUID NOT NULL,
  driver_id       UUID NOT NULL,
  inspection_date DATE NOT NULL,
  overall_status  TEXT NOT NULL,
  notes           TEXT,
  completed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_inspections_status_chk CHECK (
    overall_status IN ('PASS', 'FAIL', 'CONDITIONAL')
  ),
  CONSTRAINT trn_inspections_uq UNIQUE (vehicle_id, inspection_date),
  CONSTRAINT trn_inspections_vehicle_fk FOREIGN KEY (vehicle_id)
    REFERENCES trn_vehicles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS trn_inspections_vehicle_date_idx
  ON trn_pre_trip_inspections (vehicle_id, inspection_date DESC);

COMMENT ON TABLE trn_pre_trip_inspections IS
  'Daily pre-trip safety inspection header. driver_id is a soft FK to hr_employees enforced at the application layer. UNIQUE(vehicle, inspection_date) caps to one inspection per vehicle per day. A FAIL overall_status blocks the vehicle from starting a run via the Step 7 RunLogService check.';

CREATE TABLE IF NOT EXISTS trn_pre_trip_inspection_items (
  id              UUID PRIMARY KEY,
  inspection_id   UUID NOT NULL,
  item_name       TEXT NOT NULL,
  status          TEXT NOT NULL,
  notes           TEXT,
  CONSTRAINT trn_items_status_chk CHECK (status IN ('PASS', 'FAIL', 'NOT_APPLICABLE')),
  CONSTRAINT trn_items_inspection_fk FOREIGN KEY (inspection_id)
    REFERENCES trn_pre_trip_inspections(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS trn_items_inspection_idx
  ON trn_pre_trip_inspection_items (inspection_id);

COMMENT ON TABLE trn_pre_trip_inspection_items IS
  'Per-item checklist row for a daily inspection. 3-value status CHECK. CASCADE on parent inspection. Typical items: Tyres, Brakes, Lights, Mirrors, Emergency exit, First aid kit. Step 7 service computes overall_status from the items in one tenant tx.';

CREATE TABLE IF NOT EXISTS trn_maintenance_schedules (
  id                      UUID PRIMARY KEY,
  vehicle_id              UUID NOT NULL,
  service_type            TEXT NOT NULL,
  interval_miles          INT,
  interval_months         INT,
  last_service_date       DATE,
  last_service_mileage    INT,
  next_due_date           DATE,
  next_due_mileage        INT,
  status                  TEXT NOT NULL DEFAULT 'ON_SCHEDULE',
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_maint_status_chk CHECK (status IN ('ON_SCHEDULE', 'DUE_SOON', 'OVERDUE')),
  CONSTRAINT trn_maint_miles_chk CHECK (interval_miles IS NULL OR interval_miles > 0),
  CONSTRAINT trn_maint_months_chk CHECK (interval_months IS NULL OR interval_months > 0),
  CONSTRAINT trn_maint_vehicle_fk FOREIGN KEY (vehicle_id)
    REFERENCES trn_vehicles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS trn_maint_vehicle_due_idx
  ON trn_maintenance_schedules (vehicle_id, next_due_date);

COMMENT ON TABLE trn_maintenance_schedules IS
  'Scheduled maintenance with mileage and date drivers. 3-value status CHECK auto-computed by the application layer from next_due_date and current odometer. interval_miles and interval_months may both be set so a service is due whichever happens first.';

CREATE TABLE IF NOT EXISTS trn_driver_credentials (
  id                  UUID PRIMARY KEY,
  driver_id           UUID NOT NULL,
  credential_type     TEXT NOT NULL,
  credential_number   TEXT,
  issued_date         DATE NOT NULL,
  expiry_date         DATE NOT NULL,
  s3_key              TEXT,
  status              TEXT NOT NULL DEFAULT 'VALID',
  verified_by         UUID,
  verified_at         TIMESTAMPTZ,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_creds_type_chk CHECK (
    credential_type IN ('CDL', 'MEDICAL_CERTIFICATE', 'BACKGROUND_CHECK', 'FIRST_AID')
  ),
  CONSTRAINT trn_creds_status_chk CHECK (status IN ('VALID', 'EXPIRING_SOON', 'EXPIRED')),
  CONSTRAINT trn_creds_dates_chk CHECK (expiry_date > issued_date),
  CONSTRAINT trn_creds_uq UNIQUE (driver_id, credential_type)
);

CREATE INDEX IF NOT EXISTS trn_creds_expiry_idx
  ON trn_driver_credentials (expiry_date)
  WHERE status IN ('VALID', 'EXPIRING_SOON');

COMMENT ON TABLE trn_driver_credentials IS
  'Driver credential row keyed on (driver, type). UNIQUE(driver, credential_type) caps to one row per driver per credential type — refresh by PATCH not INSERT. Status is auto-computed by the Step 6 service: EXPIRING_SOON within 30 days of expiry_date, EXPIRED past expiry_date. Per ADR-015 the schema stores reference_number and status only — the underlying document lives behind s3_key.';
