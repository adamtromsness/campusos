/* ============================================================
 * Cycle 22 — Step 3: MDM + Infrastructure + Procurement + Selection
 * ============================================================
 *
 * 8 logical base tables completing the Cycle 22 schema phase:
 *
 *   - tech_mdm_sync_logs — per-sync row from Jamf / Intune /
 *     Mosyle / Google MDM with compliance state JSONB.
 *   - tech_mdm_alerts — open compliance alerts with multi-column
 *     resolved_chk lockstep.
 *   - tech_damage_reports — staff-filed damage reports with
 *     severity + photo array.
 *   - tech_repair_records — per-(asset, damage) repair workflow
 *     with vendor link to Cycle 8 tkt_vendors.
 *   - tech_infrastructure_items — switches / access points /
 *     servers / routers / firewalls / printers / NAS / UPS.
 *   - tech_procurement_orders — order lifecycle with optional
 *     wsk_approval_requests link.
 *   - tech_device_options — school-configurable device catalogue
 *     (ADR-066).
 *   - tech_device_selections — per-person device selection record
 *     during onboarding (ADR-066).
 *
 * Splitter-safe — no semicolons inside string literals or block
 * comments. Idempotent — re-runs are a no-op.
 * ============================================================ */

CREATE TABLE IF NOT EXISTS tech_mdm_sync_logs (
  id                     UUID PRIMARY KEY,
  asset_id               UUID NOT NULL,
  mdm_provider           TEXT NOT NULL,
  sync_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  device_name            TEXT,
  os_version             TEXT,
  last_check_in          TIMESTAMPTZ,
  is_compliant           BOOLEAN,
  compliance_details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT tech_mdm_provider_chk CHECK (
    mdm_provider IN ('JAMF', 'INTUNE', 'MOSYLE', 'GOOGLE')
  ),
  CONSTRAINT tech_mdm_log_asset_fk FOREIGN KEY (asset_id)
    REFERENCES tech_assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tech_mdm_log_asset_idx
  ON tech_mdm_sync_logs (asset_id, sync_at DESC);

COMMENT ON TABLE tech_mdm_sync_logs IS
  'Per-sync row from the MDM provider. 4-value mdm_provider CHECK (JAMF / INTUNE / MOSYLE / GOOGLE). compliance_details JSONB carries provider-specific payload (passcode policy, encryption status, allowed-app drift). CASCADE on parent asset since sync logs are meaningless without their asset. Real MDM integration is deferred — this cycle ships the schema and the manual seed-side sync row.';

CREATE TABLE IF NOT EXISTS tech_mdm_alerts (
  id                    UUID PRIMARY KEY,
  asset_id              UUID NOT NULL,
  alert_type            TEXT NOT NULL,
  alert_detail          TEXT,
  first_detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_detected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_resolved           BOOLEAN NOT NULL DEFAULT false,
  resolved_by           UUID,
  resolved_at           TIMESTAMPTZ,
  resolution_notes      TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_mdm_alert_type_chk CHECK (
    alert_type IN (
      'STALE_CHECKIN', 'POLICY_VIOLATION', 'JAILBREAK_DETECTED',
      'ENCRYPTION_DISABLED', 'UNAUTHORISED_APP', 'LOW_STORAGE'
    )
  ),
  CONSTRAINT tech_mdm_alert_resolved_chk CHECK (
    (is_resolved = false AND resolved_by IS NULL AND resolved_at IS NULL)
    OR (is_resolved = true AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  CONSTRAINT tech_mdm_alert_asset_fk FOREIGN KEY (asset_id)
    REFERENCES tech_assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tech_mdm_alert_active_idx
  ON tech_mdm_alerts (asset_id)
  WHERE is_resolved = false;

CREATE INDEX IF NOT EXISTS tech_mdm_alert_type_idx
  ON tech_mdm_alerts (alert_type, last_detected_at DESC)
  WHERE is_resolved = false;

COMMENT ON TABLE tech_mdm_alerts IS
  'Open MDM compliance alerts. 6-value alert_type CHECK. Multi-column resolved_chk keeps is_resolved + resolved_by + resolved_at lockstep — open alerts have all three null-side, resolved alerts have all three populated. Partial active_idx surfaces a school s open alerts at constant cost. resolved_by is a soft FK to platform.platform_users per ADR-001/020.';

CREATE TABLE IF NOT EXISTS tech_damage_reports (
  id                  UUID PRIMARY KEY,
  asset_id            UUID NOT NULL,
  reported_by         UUID NOT NULL,
  description         TEXT NOT NULL,
  severity            TEXT NOT NULL,
  photo_s3_keys       TEXT[] NOT NULL DEFAULT '{}'::text[],
  reported_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  repair_record_id    UUID,
  notes               TEXT,
  CONSTRAINT tech_damage_severity_chk CHECK (
    severity IN ('MINOR', 'MODERATE', 'MAJOR', 'WRITE_OFF')
  ),
  CONSTRAINT tech_damage_asset_fk FOREIGN KEY (asset_id)
    REFERENCES tech_assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tech_damage_asset_idx
  ON tech_damage_reports (asset_id, reported_at DESC);

COMMENT ON TABLE tech_damage_reports IS
  'Staff-filed device damage report. 4-value severity CHECK (MINOR / MODERATE / MAJOR / WRITE_OFF). photo_s3_keys carries 0 or more signed S3 URLs. CASCADE on parent asset. repair_record_id is a soft ref to tech_repair_records (forward-compat — the repair record is created from the damage report by the Step 5 service).';

CREATE TABLE IF NOT EXISTS tech_repair_records (
  id                          UUID PRIMARY KEY,
  asset_id                    UUID NOT NULL,
  damage_report_id            UUID,
  vendor_id                   UUID,
  repair_type                 TEXT NOT NULL,
  cost                        NUMERIC(8,2),
  estimated_return_date       DATE,
  sent_for_repair_at          TIMESTAMPTZ,
  returned_at                 TIMESTAMPTZ,
  resolution_notes            TEXT,
  status                      TEXT NOT NULL DEFAULT 'PENDING',
  created_by                  UUID NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_repair_type_chk CHECK (
    repair_type IN ('INTERNAL', 'EXTERNAL_VENDOR', 'WARRANTY_CLAIM')
  ),
  CONSTRAINT tech_repair_status_chk CHECK (
    status IN ('PENDING', 'IN_REPAIR', 'COMPLETE', 'WRITTEN_OFF')
  ),
  CONSTRAINT tech_repair_cost_chk CHECK (cost IS NULL OR cost >= 0),
  CONSTRAINT tech_repair_asset_fk FOREIGN KEY (asset_id)
    REFERENCES tech_assets(id) ON DELETE NO ACTION,
  CONSTRAINT tech_repair_damage_fk FOREIGN KEY (damage_report_id)
    REFERENCES tech_damage_reports(id) ON DELETE SET NULL,
  CONSTRAINT tech_repair_vendor_fk FOREIGN KEY (vendor_id)
    REFERENCES tkt_vendors(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS tech_repair_asset_idx
  ON tech_repair_records (asset_id, created_at DESC);

CREATE INDEX IF NOT EXISTS tech_repair_active_idx
  ON tech_repair_records (status)
  WHERE status IN ('PENDING', 'IN_REPAIR');

COMMENT ON TABLE tech_repair_records IS
  'Per-(asset, damage) repair workflow. 3-value repair_type CHECK (INTERNAL / EXTERNAL_VENDOR / WARRANTY_CLAIM). 4-value status CHECK (PENDING / IN_REPAIR / COMPLETE / WRITTEN_OFF). NO ACTION on asset preserves the repair audit trail past asset retirement. SET NULL on damage_report and vendor preserves the repair record when a damage report is removed (rare) or a vendor is hard-deleted. The Step 5 service flips parent tech_assets.status to REPAIR on INSERT and back to AVAILABLE on COMPLETE.';

CREATE TABLE IF NOT EXISTS tech_infrastructure_items (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  item_name                TEXT NOT NULL,
  item_type                TEXT NOT NULL,
  location                 TEXT NOT NULL,
  ip_address               TEXT,
  mac_address              TEXT,
  make                     TEXT,
  model                    TEXT,
  serial_number            TEXT,
  purchase_date            DATE,
  warranty_expiry          DATE,
  status                   TEXT NOT NULL DEFAULT 'ACTIVE',
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_infra_type_chk CHECK (
    item_type IN (
      'SWITCH', 'ACCESS_POINT', 'SERVER', 'ROUTER', 'FIREWALL',
      'PRINTER', 'NAS', 'UPS', 'OTHER'
    )
  ),
  CONSTRAINT tech_infra_status_chk CHECK (
    status IN ('ACTIVE', 'MAINTENANCE', 'DECOMMISSIONED')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS tech_infra_serial_uq
  ON tech_infrastructure_items (school_id, serial_number)
  WHERE serial_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS tech_infra_school_type_idx
  ON tech_infrastructure_items (school_id, item_type, status);

COMMENT ON TABLE tech_infrastructure_items IS
  'Network + facility infrastructure registry. 9-value item_type CHECK (SWITCH / ACCESS_POINT / SERVER / ROUTER / FIREWALL / PRINTER / NAS / UPS / OTHER). 3-value status CHECK (ACTIVE / MAINTENANCE / DECOMMISSIONED). Partial UNIQUE(school_id, serial_number) WHERE serial_number IS NOT NULL — serial numbers are unique across a school s estate but may be missing for older equipment.';

CREATE TABLE IF NOT EXISTS tech_procurement_orders (
  id                          UUID PRIMARY KEY,
  school_id                   UUID NOT NULL,
  order_title                 TEXT NOT NULL,
  vendor_id                   UUID,
  purchase_order_number       TEXT,
  ordered_by                  UUID NOT NULL,
  order_date                  DATE NOT NULL,
  expected_delivery_date      DATE,
  delivered_at                TIMESTAMPTZ,
  total_cost                  NUMERIC(10,2),
  status                      TEXT NOT NULL DEFAULT 'DRAFT',
  linked_approval_id          UUID,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_proc_status_chk CHECK (
    status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'ORDERED', 'DELIVERED', 'CANCELLED')
  ),
  CONSTRAINT tech_proc_cost_chk CHECK (total_cost IS NULL OR total_cost >= 0),
  CONSTRAINT tech_proc_delivered_chk CHECK (
    (status = 'DELIVERED' AND delivered_at IS NOT NULL)
    OR (status <> 'DELIVERED' AND delivered_at IS NULL)
  ),
  CONSTRAINT tech_proc_vendor_fk FOREIGN KEY (vendor_id)
    REFERENCES tkt_vendors(id) ON DELETE SET NULL,
  CONSTRAINT tech_proc_orderer_fk FOREIGN KEY (ordered_by)
    REFERENCES hr_employees(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS tech_proc_school_status_idx
  ON tech_procurement_orders (school_id, status, order_date DESC);

COMMENT ON TABLE tech_procurement_orders IS
  'IT procurement order. 6-state lifecycle CHECK (DRAFT / SUBMITTED / APPROVED / ORDERED / DELIVERED / CANCELLED) with multi-column delivered_chk pinning delivered_at to DELIVERED only. SET NULL on vendor preserves the order past vendor deactivation. NO ACTION on ordered_by (hr_employees) so audit trail survives. linked_approval_id is a soft ref to wsk_approval_requests for orders that flow through the workflow engine.';

CREATE TABLE IF NOT EXISTS tech_device_options (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  option_name              TEXT NOT NULL,
  device_type              TEXT NOT NULL,
  operating_system         TEXT NOT NULL,
  specifications           TEXT,
  software_available       TEXT[] NOT NULL DEFAULT '{}'::text[],
  cost_difference          NUMERIC(8,2) NOT NULL DEFAULT 0,
  is_active                BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_dopt_uq UNIQUE (school_id, option_name)
);

CREATE INDEX IF NOT EXISTS tech_dopt_school_active_idx
  ON tech_device_options (school_id, is_active);

COMMENT ON TABLE tech_device_options IS
  'School-configurable device selection catalogue per ADR-066. UNIQUE(school_id, option_name) — the catalogue option name is the stable handle. cost_difference > 0 means the option costs more than the school s baseline (e.g. iPad +$50 vs Chromebook baseline). software_available drives the Step 7 selection UI showing pre-installed software.';

CREATE TABLE IF NOT EXISTS tech_device_selections (
  id                  UUID PRIMARY KEY,
  person_id           UUID NOT NULL,
  option_id           UUID NOT NULL,
  selection_context   TEXT NOT NULL,
  selected_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by         UUID,
  approved_at         TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'SELECTED',
  asset_id            UUID,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_dsel_context_chk CHECK (
    selection_context IN ('ENROLMENT', 'REFRESH', 'NEW_HIRE')
  ),
  CONSTRAINT tech_dsel_status_chk CHECK (
    status IN ('SELECTED', 'APPROVED', 'PROVISIONING', 'PROVISIONED', 'CANCELLED')
  ),
  CONSTRAINT tech_dsel_approved_chk CHECK (
    (status IN ('SELECTED', 'CANCELLED') AND approved_by IS NULL AND approved_at IS NULL)
    OR (status IN ('APPROVED', 'PROVISIONING', 'PROVISIONED') AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT tech_dsel_option_fk FOREIGN KEY (option_id)
    REFERENCES tech_device_options(id) ON DELETE NO ACTION,
  CONSTRAINT tech_dsel_asset_fk FOREIGN KEY (asset_id)
    REFERENCES tech_assets(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS tech_dsel_person_idx
  ON tech_device_selections (person_id, selected_at DESC);

CREATE INDEX IF NOT EXISTS tech_dsel_pipeline_idx
  ON tech_device_selections (status)
  WHERE status IN ('SELECTED', 'APPROVED', 'PROVISIONING');

COMMENT ON TABLE tech_device_selections IS
  'Per-person device selection record per ADR-066. 3-value selection_context CHECK (ENROLMENT / REFRESH / NEW_HIRE). 5-value status CHECK (SELECTED / APPROVED / PROVISIONING / PROVISIONED / CANCELLED). Multi-column approved_chk keeps approved_by + approved_at lockstep with non-SELECTED non-CANCELLED statuses. NO ACTION on option preserves the audit trail past catalogue retirement. SET NULL on asset_id when the linked asset is hard-deleted (rare). person_id is a soft FK to platform.iam_person per ADR-001/020 — covers students / staff before they have an hr_employees row. Partial pipeline_idx surfaces the active queue at constant cost.';
