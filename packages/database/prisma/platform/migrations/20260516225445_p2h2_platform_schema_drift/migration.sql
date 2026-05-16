-- P2-H2 — Platform schema drift fixes (Steps 1.1, 1.4, 1.5, 1.6, 2.1)
-- Plus the shared raise_immutable_violation() function used by Step 3
-- tenant-side triggers (function lives in public schema so every tenant
-- can call it; tenant migration 177 attaches triggers per table).
--
-- Additive only. Safe on existing tenants:
--   - platform_audit_log: 2 new nullable columns + 1 new index
--   - platform_reference_health: 2 new defaulted columns + dedup + UNIQUE
--   - 3 new tables (platform_signature_requests, partition_mgmt_health,
--     compliance_ferpa_requests) — no existing data to migrate
--
-- The platform_reference_health dedup keeps the most-recent scan per
-- (source_schema, source_table, source_column) tuple. This is the
-- semantically-correct "registry shape" the hardening plan calls for —
-- the worker UPSERTs after this migration runs.

-- ── Step 3: shared IMMUTABLE function (public schema) ──
-- Prisma migrate-deploy handles the $$ dollar-quoting cleanly — only
-- the splitter that runs tenant migrations is naive. This function
-- lives in public so every tenant schema's triggers can call it via
-- unqualified function name (search_path includes public).
CREATE OR REPLACE FUNCTION public.raise_immutable_violation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE table % does not allow % - ADR-010 audit record',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.raise_immutable_violation() IS
  'P2-H2 Step 3 - defence-in-depth IMMUTABLE enforcement per ADR-010. Attached as BEFORE UPDATE OR DELETE FOR EACH ROW trigger on the 12 IMMUTABLE tables in every tenant schema. Service layer already refuses UPDATE/DELETE methods; this is the DB-level safety net.';

-- ── Step 2.1: platform_audit_log gains data_subject_id + action_category ──
ALTER TABLE platform.platform_audit_log
  ADD COLUMN IF NOT EXISTS action_category TEXT,
  ADD COLUMN IF NOT EXISTS data_subject_id UUID;

CREATE INDEX IF NOT EXISTS "platform_audit_log_data_subject_id_created_at_idx"
  ON platform.platform_audit_log (data_subject_id, created_at DESC);

-- ── Step 1.1: platform_reference_health gains target_module + severity ──
ALTER TABLE platform.platform_reference_health
  ADD COLUMN IF NOT EXISTS target_module TEXT NOT NULL DEFAULT 'platform',
  ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'WARNING';

-- Deduplicate the existing event-log-per-scan rows to registry-per-reference
-- by keeping only the most-recent scan per source triple. The
-- SoftIntegrityHealthWorker will UPSERT into the surviving rows.
DELETE FROM platform.platform_reference_health a
USING platform.platform_reference_health b
WHERE a.source_schema = b.source_schema
  AND a.source_table = b.source_table
  AND a.source_column = b.source_column
  AND a.scanned_at < b.scanned_at;

CREATE UNIQUE INDEX IF NOT EXISTS "platform_reference_health_source_uq"
  ON platform.platform_reference_health (source_schema, source_table, source_column);

CREATE INDEX IF NOT EXISTS "platform_reference_health_severity_orphan_count_idx"
  ON platform.platform_reference_health (severity, orphan_count DESC);

-- ── Step 1.4: platform_signature_requests ──
CREATE TABLE IF NOT EXISTS platform.platform_signature_requests (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  document_type TEXT NOT NULL,
  document_s3_key TEXT,
  signer_person_id UUID NOT NULL,
  signer_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  expires_at TIMESTAMPTZ,
  signed_at TIMESTAMPTZ,
  signed_by UUID,
  signature_method TEXT,
  declined_at TIMESTAMPTZ,
  decline_reason TEXT,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID,
  source_module TEXT NOT NULL,
  source_ref_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "platform_signature_requests_tenant_id_status_created_at_idx"
  ON platform.platform_signature_requests (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS "platform_signature_requests_signer_person_id_status_idx"
  ON platform.platform_signature_requests (signer_person_id, status);
CREATE INDEX IF NOT EXISTS "platform_signature_requests_source_module_source_ref_id_idx"
  ON platform.platform_signature_requests (source_module, source_ref_id);

-- ── Step 1.5: partition_mgmt_health ──
CREATE TABLE IF NOT EXISTS platform.partition_mgmt_health (
  id UUID PRIMARY KEY,
  schema_name TEXT NOT NULL,
  parent_table TEXT NOT NULL,
  partition_name TEXT NOT NULL,
  partition_strategy TEXT NOT NULL,
  range_start TEXT,
  range_end TEXT,
  hash_remainder INTEGER,
  row_count BIGINT NOT NULL DEFAULT 0,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  scan_duration_ms INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS "partition_mgmt_health_schema_parent_partition_uq"
  ON platform.partition_mgmt_health (schema_name, parent_table, partition_name);
CREATE INDEX IF NOT EXISTS "partition_mgmt_health_status_scanned_at_idx"
  ON platform.partition_mgmt_health (status, scanned_at DESC);
CREATE INDEX IF NOT EXISTS "partition_mgmt_health_schema_parent_idx"
  ON platform.partition_mgmt_health (schema_name, parent_table);

-- ── Step 1.6: compliance_ferpa_requests ──
CREATE TABLE IF NOT EXISTS platform.compliance_ferpa_requests (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  school_id UUID,
  requester_person_id UUID NOT NULL,
  requester_relation TEXT NOT NULL,
  student_person_id UUID NOT NULL,
  request_type TEXT NOT NULL,
  records_scope TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RECEIVED',
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline_at TIMESTAMPTZ NOT NULL,
  acknowledged_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  released_records_s3_key TEXT,
  denied_at TIMESTAMPTZ,
  denial_reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "compliance_ferpa_requests_tenant_status_deadline_idx"
  ON platform.compliance_ferpa_requests (tenant_id, status, deadline_at);
CREATE INDEX IF NOT EXISTS "compliance_ferpa_requests_requester_received_idx"
  ON platform.compliance_ferpa_requests (requester_person_id, received_at DESC);
CREATE INDEX IF NOT EXISTS "compliance_ferpa_requests_student_received_idx"
  ON platform.compliance_ferpa_requests (student_person_id, received_at DESC);
