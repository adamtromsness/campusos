/*
 * 156_tech_remote_actions_audit.sql — P2-20a Step 1.
 *
 * IT Advanced (M62 .1) operational depth on top of the Cycle 22 IT
 * Infrastructure base. Five new tables in this migration:
 *
 *   tech_remote_actions          IMMUTABLE audit log of every MDM
 *                                remote command (LOCK, WIPE, RESTART,
 *                                LOCATE, UNENROLL, ENABLE_LOST_MODE,
 *                                DISABLE_LOST_MODE). No UPDATE, no
 *                                DELETE at the service layer. Mandatory
 *                                justification with CHECK on length
 *                                trimmed greater than or equal to 20
 *                                characters. The MDM provider write is
 *                                stubbed this cycle — only the row is
 *                                recorded. WIPE plus COMPLETED auto
 *                                resets tech_assets.status to AVAILABLE
 *                                at the service layer (cross-table
 *                                invariant cannot live in the schema).
 *
 *   tech_licence_renewals        Renewal ledger keyed on the parent
 *                                tech_software_licences row. INSERT
 *                                also updates the parent expiry_date
 *                                at the service layer. Captures
 *                                previous and new expiry dates plus
 *                                renewal cost for the licence cost
 *                                history chart.
 *
 *   tech_device_usage_summaries  Per-(asset, date) daily usage rolled
 *                                up from MDM provider data. Includes
 *                                screen_time_minutes, apps_used array,
 *                                and a flagged_activity boolean that
 *                                the Step 8 flagged-activity emit
 *                                consumes. UNIQUE on (asset_id,
 *                                summary_date) so a reseed or repeat
 *                                sync overwrites cleanly.
 *
 *   tech_inventory_audits        Formal physical inventory audit
 *                                header. Captures expected vs found vs
 *                                missing vs unrecorded counters. Two
 *                                value status CHECK IN_PROGRESS or
 *                                COMPLETED with completed_at lockstep.
 *
 *   tech_inventory_audit_items   Per-asset audit row. asset_id is
 *                                nullable for unrecorded assets
 *                                (scanned but not registered).
 *                                UNIQUE(audit_id, asset_tag) keeps the
 *                                roster clean. 4 value condition_observed
 *                                CHECK is nullable for not-found rows.
 *
 * FK summary (intra-tenant only, 0 cross-schema):
 *   tech_remote_actions.asset_id          tech_assets(id) NO ACTION
 *   tech_licence_renewals.licence_id      tech_software_licences(id) NO ACTION
 *   tech_device_usage_summaries.asset_id  tech_assets(id) ON DELETE CASCADE
 *   tech_inventory_audit_items.audit_id   tech_inventory_audits(id) ON DELETE CASCADE
 *   tech_inventory_audit_items.asset_id   tech_assets(id) ON DELETE SET NULL
 *
 * Splitter discipline — no semicolons inside string literals, default
 * expressions, COMMENT bodies, CHECK predicates, or block comments.
 * Idempotent — safe to re-run.
 */


CREATE TABLE IF NOT EXISTS tech_remote_actions (
  id                       UUID PRIMARY KEY,
  asset_id                 UUID NOT NULL,
  action_type              TEXT NOT NULL,
  initiated_by             UUID NOT NULL,
  initiated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  justification            TEXT NOT NULL,
  mdm_command_ref          TEXT,
  status                   TEXT NOT NULL DEFAULT 'PENDING',
  completed_at             TIMESTAMPTZ,
  failure_reason           TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_remote_actions_type_chk CHECK (
    action_type IN (
      'LOCK', 'WIPE', 'RESTART', 'LOCATE',
      'UNENROLL', 'ENABLE_LOST_MODE', 'DISABLE_LOST_MODE'
    )
  ),
  CONSTRAINT tech_remote_actions_status_chk CHECK (
    status IN ('PENDING', 'SENT', 'COMPLETED', 'FAILED')
  ),
  CONSTRAINT tech_remote_actions_justification_chk CHECK (
    length(trim(justification)) >= 20
  ),
  CONSTRAINT tech_remote_actions_completed_chk CHECK (
    (status IN ('PENDING', 'SENT') AND completed_at IS NULL)
    OR (status = 'COMPLETED' AND completed_at IS NOT NULL)
    OR (status = 'FAILED' AND completed_at IS NOT NULL)
  ),
  CONSTRAINT tech_remote_actions_failure_chk CHECK (
    (status = 'FAILED' AND failure_reason IS NOT NULL AND length(trim(failure_reason)) > 0)
    OR (status <> 'FAILED' AND failure_reason IS NULL)
  ),
  CONSTRAINT tech_remote_actions_asset_fk FOREIGN KEY (asset_id)
    REFERENCES tech_assets(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS tech_remote_actions_asset_initiated_idx
  ON tech_remote_actions (asset_id, initiated_at DESC);

CREATE INDEX IF NOT EXISTS tech_remote_actions_status_idx
  ON tech_remote_actions (status);

COMMENT ON TABLE tech_remote_actions IS
  'P2-20a — IMMUTABLE audit log of MDM remote actions. No UPDATE and no DELETE allowed at the service layer. justification mandatory length trimmed >= 20. WIPE + COMPLETED transition flips tech_assets.status to AVAILABLE in the same tenant tx as the status update (cross-table invariant lives in the service).';


CREATE TABLE IF NOT EXISTS tech_licence_renewals (
  id                       UUID PRIMARY KEY,
  licence_id               UUID NOT NULL,
  previous_expiry_date     DATE NOT NULL,
  new_expiry_date          DATE NOT NULL,
  renewal_cost             NUMERIC(10,2),
  renewed_by               UUID NOT NULL,
  renewed_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_licence_renewals_cost_chk CHECK (
    renewal_cost IS NULL OR renewal_cost >= 0
  ),
  CONSTRAINT tech_licence_renewals_dates_chk CHECK (
    new_expiry_date >= previous_expiry_date
  ),
  CONSTRAINT tech_licence_renewals_licence_fk FOREIGN KEY (licence_id)
    REFERENCES tech_software_licences(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS tech_licence_renewals_licence_renewed_idx
  ON tech_licence_renewals (licence_id, renewed_at DESC);

COMMENT ON TABLE tech_licence_renewals IS
  'P2-20a — Licence renewal ledger. INSERT updates tech_software_licences.expiry_date at the service layer in the same tenant tx. Captures renewal cost for the licence cost history chart on the licence dashboard.';


CREATE TABLE IF NOT EXISTS tech_device_usage_summaries (
  id                       UUID PRIMARY KEY,
  asset_id                 UUID NOT NULL,
  summary_date             DATE NOT NULL,
  screen_time_minutes      INT,
  apps_used                TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  flagged_activity         BOOLEAN NOT NULL DEFAULT false,
  summary_source           TEXT,
  recorded_by              UUID,
  recorded_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_device_usage_summaries_uq UNIQUE (asset_id, summary_date),
  CONSTRAINT tech_device_usage_summaries_screen_chk CHECK (
    screen_time_minutes IS NULL OR screen_time_minutes >= 0
  ),
  CONSTRAINT tech_device_usage_summaries_asset_fk FOREIGN KEY (asset_id)
    REFERENCES tech_assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tech_device_usage_summaries_asset_date_idx
  ON tech_device_usage_summaries (asset_id, summary_date DESC);

CREATE INDEX IF NOT EXISTS tech_device_usage_summaries_flagged_idx
  ON tech_device_usage_summaries (asset_id, summary_date DESC)
  WHERE flagged_activity = true;

COMMENT ON TABLE tech_device_usage_summaries IS
  'P2-20a — Per-asset per-day usage rollup from MDM provider data (manual entry this cycle). flagged_activity=true rows emit tech.usage.flagged for IT admin review (Step 8).';


CREATE TABLE IF NOT EXISTS tech_inventory_audits (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  audit_name               TEXT NOT NULL,
  building                 TEXT,
  conducted_by             UUID NOT NULL,
  audit_date               DATE NOT NULL,
  total_assets_expected    INT NOT NULL DEFAULT 0,
  total_assets_found       INT NOT NULL DEFAULT 0,
  total_assets_missing     INT NOT NULL DEFAULT 0,
  total_assets_unrecorded  INT NOT NULL DEFAULT 0,
  audit_notes              TEXT,
  status                   TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  completed_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_inventory_audits_status_chk CHECK (
    status IN ('IN_PROGRESS', 'COMPLETED')
  ),
  CONSTRAINT tech_inventory_audits_counters_chk CHECK (
    total_assets_expected >= 0
    AND total_assets_found >= 0
    AND total_assets_missing >= 0
    AND total_assets_unrecorded >= 0
  ),
  CONSTRAINT tech_inventory_audits_completed_chk CHECK (
    (status = 'IN_PROGRESS' AND completed_at IS NULL)
    OR (status = 'COMPLETED' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS tech_inventory_audits_school_date_idx
  ON tech_inventory_audits (school_id, audit_date DESC);

COMMENT ON TABLE tech_inventory_audits IS
  'P2-20a — Formal physical inventory audit header. building is nullable so a school-wide audit covers every asset. status flips IN_PROGRESS to COMPLETED only via /complete which finalises the counters and stamps completed_at.';


CREATE TABLE IF NOT EXISTS tech_inventory_audit_items (
  id                       UUID PRIMARY KEY,
  audit_id                 UUID NOT NULL,
  asset_id                 UUID,
  asset_tag                TEXT NOT NULL,
  found                    BOOLEAN NOT NULL,
  condition_observed       TEXT,
  location_observed        TEXT,
  discrepancy_notes        TEXT,
  scanned_by               UUID,
  scanned_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tech_inventory_audit_items_uq UNIQUE (audit_id, asset_tag),
  CONSTRAINT tech_inventory_audit_items_condition_chk CHECK (
    condition_observed IS NULL
    OR condition_observed IN ('EXCELLENT', 'GOOD', 'FAIR', 'DAMAGED')
  ),
  CONSTRAINT tech_inventory_audit_items_audit_fk FOREIGN KEY (audit_id)
    REFERENCES tech_inventory_audits(id) ON DELETE CASCADE,
  CONSTRAINT tech_inventory_audit_items_asset_fk FOREIGN KEY (asset_id)
    REFERENCES tech_assets(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS tech_inventory_audit_items_audit_idx
  ON tech_inventory_audit_items (audit_id, found);

COMMENT ON TABLE tech_inventory_audit_items IS
  'P2-20a — Per-asset audit row. asset_id is nullable for unrecorded assets (scanned tag not in tech_assets). UNIQUE(audit_id, asset_tag) keeps the per-audit roster clean. SET NULL on asset_id so a hard-deleted asset preserves the audit history.';
