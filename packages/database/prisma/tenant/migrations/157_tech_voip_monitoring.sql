/*
 * 157_tech_voip_monitoring.sql — P2-20a Step 2.
 *
 * IT Advanced (M62 .1) continued. Four new tables plus an additive
 * ALTER on the existing Cycle 22 tech_infrastructure_items:
 *
 *   tech_phone_extensions        Per-school VOIP extension directory.
 *                                UNIQUE(school_id, extension_number).
 *                                5 value extension_type CHECK
 *                                DESK / CLASSROOM / OFFICE /
 *                                COMMON_AREA / FAX. assigned_to is a
 *                                soft ref to hr_employees per
 *                                ADR-001/020 — service-layer validates.
 *
 *   tech_config_documentation    Versioned IT configuration docs.
 *                                UNIQUE(school_id, title) so a title
 *                                exists once per school. version INT
 *                                increments at the service layer on
 *                                update. 7 value category CHECK.
 *
 *   tech_monitoring_checks       Uptime / liveness check definition.
 *                                UNIQUE(school_id, system_name). The
 *                                Step 5 service polls and records
 *                                results via /result — consecutive
 *                                failures past the threshold create a
 *                                tech_monitoring_alerts row.
 *
 *   tech_monitoring_alerts       Lifecycle row per outage. 3 value
 *                                alert_type CHECK DOWN / DEGRADED /
 *                                RECOVERED. Partial INDEX on
 *                                (check_id, detected_at DESC) WHERE
 *                                resolved_at IS NULL feeds the active
 *                                alerts dashboard. acknowledged_by +
 *                                acknowledged_at are app-layer set by
 *                                /acknowledge.
 *
 *   tech_infrastructure_items    ALTER TABLE ADD COLUMN last_checked_at
 *                                TIMESTAMPTZ. The base table ships from
 *                                Cycle 22 migration 077. P2-20 spec
 *                                calls for the column so the
 *                                infrastructure registry can show
 *                                stale-check warnings.
 *
 * FK summary (intra-tenant only, 0 cross-schema):
 *   tech_phone_extensions.assigned_to    soft ref to hr_employees(id)
 *                                        (ADR-001/020, no DB FK)
 *   tech_config_documentation.last_updated_by  soft ref to platform.iam_person
 *   tech_monitoring_checks.created_by    soft ref to platform.iam_person
 *   tech_monitoring_alerts.check_id      tech_monitoring_checks(id) ON DELETE CASCADE
 *   tech_monitoring_alerts.acknowledged_by soft ref to platform.iam_person
 *
 * Splitter discipline — no semicolons inside string literals, default
 * expressions, COMMENT bodies, CHECK predicates, or block comments.
 * Idempotent — safe to re-run.
 */


CREATE TABLE IF NOT EXISTS tech_phone_extensions (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  extension_number         TEXT NOT NULL,
  assigned_to              UUID,
  display_name             TEXT,
  location                 TEXT,
  department               TEXT,
  extension_type           TEXT NOT NULL,
  is_active                BOOLEAN NOT NULL DEFAULT true,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_phone_extensions_uq UNIQUE (school_id, extension_number),
  CONSTRAINT tech_phone_extensions_type_chk CHECK (
    extension_type IN ('DESK', 'CLASSROOM', 'OFFICE', 'COMMON_AREA', 'FAX')
  )
);

CREATE INDEX IF NOT EXISTS tech_phone_extensions_assigned_idx
  ON tech_phone_extensions (school_id, assigned_to)
  WHERE assigned_to IS NOT NULL;

CREATE INDEX IF NOT EXISTS tech_phone_extensions_active_idx
  ON tech_phone_extensions (school_id, is_active);

COMMENT ON TABLE tech_phone_extensions IS
  'P2-20a — VOIP extension directory. UNIQUE(school_id, extension_number). assigned_to is a soft ref to hr_employees per ADR-001/020. The Step 5 directory endpoint joins through hr_employees plus platform.iam_person for the assignee display name.';


CREATE TABLE IF NOT EXISTS tech_config_documentation (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  title                    TEXT NOT NULL,
  category                 TEXT NOT NULL,
  content_markdown         TEXT NOT NULL,
  version                  INT NOT NULL DEFAULT 1,
  diagram_s3_key           TEXT,
  last_updated_by          UUID NOT NULL,
  last_updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_config_documentation_uq UNIQUE (school_id, title),
  CONSTRAINT tech_config_documentation_category_chk CHECK (
    category IN (
      'NETWORK_TOPOLOGY', 'SERVER_CONFIG', 'WIFI', 'VOIP',
      'FIREWALL', 'BACKUP', 'OTHER'
    )
  ),
  CONSTRAINT tech_config_documentation_version_chk CHECK (version >= 1)
);

CREATE INDEX IF NOT EXISTS tech_config_documentation_category_idx
  ON tech_config_documentation (school_id, category);

COMMENT ON TABLE tech_config_documentation IS
  'P2-20a — Versioned IT configuration documentation. UNIQUE(school_id, title) so a title exists once per school. The Step 5 service increments version on every update and exposes /history for prior versions via a side table the Step 5 service plans to add when versioned-history UI ships.';


CREATE TABLE IF NOT EXISTS tech_monitoring_checks (
  id                                 UUID PRIMARY KEY,
  school_id                          UUID NOT NULL,
  system_name                        TEXT NOT NULL,
  check_url                          TEXT,
  check_type                         TEXT NOT NULL,
  interval_minutes                   INT NOT NULL DEFAULT 5,
  expected_status_code               INT DEFAULT 200,
  timeout_seconds                    INT NOT NULL DEFAULT 10,
  consecutive_failures_to_alert      INT NOT NULL DEFAULT 2,
  is_active                          BOOLEAN NOT NULL DEFAULT true,
  last_status                        TEXT,
  last_checked_at                    TIMESTAMPTZ,
  consecutive_failures               INT NOT NULL DEFAULT 0,
  created_by                         UUID NOT NULL,
  created_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_monitoring_checks_uq UNIQUE (school_id, system_name),
  CONSTRAINT tech_monitoring_checks_type_chk CHECK (
    check_type IN ('HTTP', 'PING', 'TCP', 'MANUAL')
  ),
  CONSTRAINT tech_monitoring_checks_interval_chk CHECK (interval_minutes >= 1),
  CONSTRAINT tech_monitoring_checks_timeout_chk CHECK (timeout_seconds >= 1),
  CONSTRAINT tech_monitoring_checks_threshold_chk CHECK (
    consecutive_failures_to_alert >= 1
  ),
  CONSTRAINT tech_monitoring_checks_failures_chk CHECK (
    consecutive_failures >= 0
  ),
  CONSTRAINT tech_monitoring_checks_last_status_chk CHECK (
    last_status IS NULL
    OR last_status IN ('HEALTHY', 'DEGRADED', 'DOWN', 'UNKNOWN')
  )
);

CREATE INDEX IF NOT EXISTS tech_monitoring_checks_active_idx
  ON tech_monitoring_checks (school_id, is_active);

COMMENT ON TABLE tech_monitoring_checks IS
  'P2-20a — Uptime monitoring check definition. consecutive_failures tracks the running streak of non-HEALTHY results — the Step 5 service creates a tech_monitoring_alerts DOWN row when the streak crosses consecutive_failures_to_alert and resets the streak on HEALTHY.';


CREATE TABLE IF NOT EXISTS tech_monitoring_alerts (
  id                       UUID PRIMARY KEY,
  check_id                 UUID NOT NULL,
  alert_type               TEXT NOT NULL,
  detected_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at              TIMESTAMPTZ,
  response_time_ms         INT,
  status_code              INT,
  error_message            TEXT,
  acknowledged_by          UUID,
  acknowledged_at          TIMESTAMPTZ,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_monitoring_alerts_type_chk CHECK (
    alert_type IN ('DOWN', 'DEGRADED', 'RECOVERED')
  ),
  CONSTRAINT tech_monitoring_alerts_response_chk CHECK (
    response_time_ms IS NULL OR response_time_ms >= 0
  ),
  CONSTRAINT tech_monitoring_alerts_ack_chk CHECK (
    (acknowledged_by IS NULL AND acknowledged_at IS NULL)
    OR (acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL)
  ),
  CONSTRAINT tech_monitoring_alerts_check_fk FOREIGN KEY (check_id)
    REFERENCES tech_monitoring_checks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tech_monitoring_alerts_check_detected_idx
  ON tech_monitoring_alerts (check_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS tech_monitoring_alerts_active_idx
  ON tech_monitoring_alerts (check_id, detected_at DESC)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE tech_monitoring_alerts IS
  'P2-20a — Per-outage alert row. acknowledged_by + acknowledged_at lockstep CHECK keeps the audit clean. Partial INDEX(check_id, detected_at DESC) WHERE resolved_at IS NULL feeds the active-alerts dashboard hot path. The Step 5 service emits tech.monitoring.alert AFTER the tx commits on a new DOWN row.';


/* tech_infrastructure_items already exists from Cycle 22 migration 077.
   P2-20 spec adds last_checked_at for the infrastructure registry. */
ALTER TABLE tech_infrastructure_items
  ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;

COMMENT ON COLUMN tech_infrastructure_items.last_checked_at IS
  'P2-20a — Last time IT staff physically verified or remotely pinged this infrastructure item. Stale entries surface as warnings on the infrastructure registry. Nullable since legacy rows from Cycle 22 predate this column.';
