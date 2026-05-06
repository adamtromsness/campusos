/*
 * 066_trn_ridership_operations.sql — Cycle 19 Step 3.
 *
 * M61 Transportation domain 3: student boarding and alighting scan
 * records, QR-code bus passes, route run execution logs, no-show
 * alert records (the safeguarding keystone), and delay reports.
 *
 * Soft FKs to platform.iam_person and hr_employees and sis_students
 * per ADR-001 and ADR-020 are not enforced at the schema level. The
 * NoShowWorker keystone in Step 7 walks expected ridership against
 * actual scans and inserts trn_no_show_alerts ON CONFLICT DO NOTHING
 * — UNIQUE(student, route, expected_date, expected_stop) is the
 * redelivery dedup gate so a worker re-run cannot double-fire.
 *
 * No semicolons inside string literals or block comments.
 */

CREATE TABLE IF NOT EXISTS trn_ridership_records (
  id              UUID PRIMARY KEY,
  student_id      UUID NOT NULL,
  route_id        UUID NOT NULL,
  stop_id         UUID NOT NULL,
  scan_direction  TEXT NOT NULL,
  scanned_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  scanned_by      UUID,
  scan_method     TEXT NOT NULL DEFAULT 'QR_CODE',
  bus_pass_id     UUID,
  notes           TEXT,
  CONSTRAINT trn_ridership_direction_chk CHECK (
    scan_direction IN ('BOARDING', 'ALIGHTING')
  ),
  CONSTRAINT trn_ridership_method_chk CHECK (
    scan_method IN ('QR_CODE', 'MANUAL', 'RFID')
  ),
  CONSTRAINT trn_ridership_route_fk FOREIGN KEY (route_id)
    REFERENCES trn_routes(id) ON DELETE CASCADE,
  CONSTRAINT trn_ridership_stop_fk FOREIGN KEY (stop_id)
    REFERENCES trn_stops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS trn_ridership_student_at_idx
  ON trn_ridership_records (student_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS trn_ridership_route_at_idx
  ON trn_ridership_records (route_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS trn_ridership_today_idx
  ON trn_ridership_records (route_id, scan_direction, scanned_at);

COMMENT ON TABLE trn_ridership_records IS
  'Boarding or alighting scan event. 2-value scan_direction CHECK and 3-value scan_method CHECK. Partition-ready for RANGE(scanned_at) monthly when ridership volume warrants it. Stamped by the Step 7 RidershipService.scan keystone after QR token resolution.';

CREATE TABLE IF NOT EXISTS trn_bus_passes (
  id                  UUID PRIMARY KEY,
  student_id          UUID NOT NULL,
  academic_year_id    UUID,
  pass_type           TEXT NOT NULL,
  qr_code_token       TEXT NOT NULL UNIQUE,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  valid_from          DATE NOT NULL,
  valid_to            DATE NOT NULL,
  issued_by           UUID,
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes               TEXT,
  CONSTRAINT trn_passes_type_chk CHECK (pass_type IN ('ANNUAL', 'TERM', 'DAILY')),
  CONSTRAINT trn_passes_window_chk CHECK (valid_to >= valid_from)
);

CREATE INDEX IF NOT EXISTS trn_passes_token_idx
  ON trn_bus_passes (qr_code_token);
CREATE INDEX IF NOT EXISTS trn_passes_student_active_idx
  ON trn_bus_passes (student_id)
  WHERE is_active = true;

COMMENT ON TABLE trn_bus_passes IS
  'QR-coded bus pass. qr_code_token is a globally-unique opaque token written into the printed QR code — the Step 7 RidershipService.scan keystone resolves the student via this token and validates is_active and the valid_from..valid_to window before stamping a ridership record. UNIQUE on the token so a scan resolves deterministically.';

CREATE TABLE IF NOT EXISTS trn_route_run_logs (
  id              UUID PRIMARY KEY,
  route_id        UUID NOT NULL,
  vehicle_id      UUID NOT NULL,
  driver_id       UUID NOT NULL,
  run_date        DATE NOT NULL,
  departure_time  TIMESTAMPTZ,
  arrival_time    TIMESTAMPTZ,
  odometer_start  INT,
  odometer_end    INT,
  students_boarded INT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_runs_status_chk CHECK (
    status IN ('IN_PROGRESS', 'COMPLETED', 'CANCELLED')
  ),
  CONSTRAINT trn_runs_odometer_chk CHECK (
    odometer_end IS NULL OR odometer_start IS NULL OR odometer_end >= odometer_start
  ),
  CONSTRAINT trn_runs_window_chk CHECK (
    arrival_time IS NULL OR departure_time IS NULL OR arrival_time >= departure_time
  ),
  CONSTRAINT trn_runs_route_fk FOREIGN KEY (route_id)
    REFERENCES trn_routes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS trn_runs_route_date_idx
  ON trn_route_run_logs (route_id, run_date DESC);

COMMENT ON TABLE trn_route_run_logs IS
  'One row per route execution. 3-value status CHECK with multi-column window_chk (arrival >= departure when both set) and odometer_chk (end >= start when both set). students_boarded denormalised counter for a quick run summary — the canonical count remains COUNT(trn_ridership_records) joined to the run.';

CREATE TABLE IF NOT EXISTS trn_no_show_alerts (
  id                  UUID PRIMARY KEY,
  student_id          UUID NOT NULL,
  route_id            UUID NOT NULL,
  expected_date       DATE NOT NULL,
  expected_stop_id    UUID NOT NULL,
  alert_time          TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolution          TEXT,
  resolved_by         UUID,
  resolved_at         TIMESTAMPTZ,
  parent_notified_at  TIMESTAMPTZ,
  resolution_notes    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_noshow_resolution_chk CHECK (
    resolution IS NULL
    OR resolution IN ('ABSENT_CONFIRMED', 'LATE_ARRIVAL', 'PARENT_NOTIFIED', 'FALSE_ALARM')
  ),
  CONSTRAINT trn_noshow_resolved_chk CHECK (
    (resolution IS NULL AND resolved_by IS NULL AND resolved_at IS NULL)
    OR (resolution IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  CONSTRAINT trn_noshow_route_fk FOREIGN KEY (route_id)
    REFERENCES trn_routes(id) ON DELETE CASCADE,
  CONSTRAINT trn_noshow_stop_fk FOREIGN KEY (expected_stop_id)
    REFERENCES trn_stops(id) ON DELETE CASCADE,
  CONSTRAINT trn_noshow_uq UNIQUE (student_id, route_id, expected_date, expected_stop_id)
);

CREATE INDEX IF NOT EXISTS trn_noshow_date_resolution_idx
  ON trn_no_show_alerts (expected_date, resolution);

COMMENT ON TABLE trn_no_show_alerts IS
  'SAFEGUARDING KEYSTONE. UNIQUE(student, route, expected_date, expected_stop) is the redelivery dedup gate so the NoShowWorker can re-run safely. nullable 4-value resolution CHECK with multi-column resolved_chk lockstep keeping resolved_by + resolved_at all-set or all-null. The Step 7 service emits trn.no_show.detected on every fresh insert for parent notification fan-out.';

CREATE TABLE IF NOT EXISTS trn_delay_reports (
  id                          UUID PRIMARY KEY,
  route_id                    UUID NOT NULL,
  run_date                    DATE NOT NULL,
  reported_by                 UUID NOT NULL,
  delay_minutes               INT NOT NULL,
  reason                      TEXT NOT NULL,
  affected_stops              TEXT[],
  parent_notification_sent    BOOLEAN NOT NULL DEFAULT false,
  reported_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trn_delay_minutes_chk CHECK (delay_minutes > 0),
  CONSTRAINT trn_delay_route_fk FOREIGN KEY (route_id)
    REFERENCES trn_routes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS trn_delay_route_date_idx
  ON trn_delay_reports (route_id, run_date DESC);

COMMENT ON TABLE trn_delay_reports IS
  'Driver-reported delay record. delay_minutes > 0 CHECK rejects no-op zero-minute reports. affected_stops TEXT[] records the human-readable subset of stops impacted. Step 7 service emits trn.delay.reported for parent notification fan-out via Cycle 14 messaging.';
