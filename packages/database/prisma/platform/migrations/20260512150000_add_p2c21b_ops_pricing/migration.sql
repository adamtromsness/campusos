-- P2-21b Internal Ops + Pricing (M91 + Platform Pricing) — platform
-- schema, internal-only.
--
-- 9 platform tables: ops_employees, ops_permissions,
-- ops_account_assignments, ops_tenant_access_grants,
-- ops_internal_tickets, ops_internal_ticket_comments,
-- platform_pricing_bands, platform_pricing_history,
-- platform_support_tiers.
--
-- ADR-072. Internal operations for CampusOS-the-company. NOT visible
-- to school tenants. CampusOS staff are tracked here separately from
-- school hr_employees. Tenant access grants are FERPA/GDPR-audited
-- with a hard 4-hour maximum and mandatory justification of at least
-- 20 characters. Emits ops.tenant_access.granted.
--
-- Soft UUID refs to platform.iam_person (employee binding),
-- platform.crm_accounts (account assignments + ticket linkage),
-- platform.schools (tenant access target). No DB FKs across
-- platform-internal child tables to those parents per the soft-ref
-- convention; the FKs we DO declare are between siblings inside
-- this migration's own bounded set (employee >- permissions,
-- assignments, tenant access, tickets; checklist >- comments;
-- band >- history).
-- =====================================================================

-- ── ops_employees ───────────────────────────────────────────────────
-- CampusOS staff. Distinct from school hr_employees by design —
-- school employees are tenant-scoped and CampusOS staff are
-- platform-scoped operators. person_id is soft-FK to iam_person so
-- the same canonical identity can be assigned to both a school and
-- to CampusOS-the-company at different scopes via separate role
-- assignments.

CREATE TABLE IF NOT EXISTS "platform"."ops_employees" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "department" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "hire_date" DATE NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_employees_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ops_employees_person_uq" UNIQUE ("person_id"),
    CONSTRAINT "ops_employees_department_chk" CHECK (
      "department" IN (
        'ENGINEERING', 'PRODUCT', 'SALES', 'CUSTOMER_SUCCESS',
        'SUPPORT', 'OPERATIONS'
      )
    )
);

CREATE INDEX IF NOT EXISTS "ops_employees_active_idx"
  ON "platform"."ops_employees" ("is_active") WHERE "is_active" = true;

CREATE INDEX IF NOT EXISTS "ops_employees_department_idx"
  ON "platform"."ops_employees" ("department");

COMMENT ON TABLE "platform"."ops_employees" IS
  'P2-21b — CampusOS-the-company staff. Distinct from school hr_employees (which is tenant-scoped). 6-value department CHECK. Soft FK to platform.iam_person via person_id (UNIQUE). ADR-072.';

COMMENT ON COLUMN "platform"."ops_employees"."person_id" IS
  'Soft FK to platform.iam_person(id) per ADR-001/020. UNIQUE — one ops_employees row per canonical identity.';


-- ── ops_permissions ──────────────────────────────────────────────────
-- Internal scope permissions per ops_employee. UNIQUE(employee, scope)
-- so a scope is held at most once per employee. granted_by is a soft
-- FK to ops_employees too (a CampusOS admin grants the permission).

CREATE TABLE IF NOT EXISTS "platform"."ops_permissions" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "granted_by" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_permissions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ops_permissions_employee_fkey" FOREIGN KEY ("employee_id")
      REFERENCES "platform"."ops_employees"("id") ON DELETE CASCADE,
    CONSTRAINT "ops_permissions_granted_by_fkey" FOREIGN KEY ("granted_by")
      REFERENCES "platform"."ops_employees"("id") ON DELETE RESTRICT,
    CONSTRAINT "ops_permissions_scope_chk" CHECK (
      "scope" IN (
        'CRM_READ', 'CRM_WRITE', 'TENANT_ACCESS',
        'INTERNAL_ADMIN', 'SUPPORT'
      )
    ),
    CONSTRAINT "ops_permissions_employee_scope_uq" UNIQUE ("employee_id", "scope")
);

CREATE INDEX IF NOT EXISTS "ops_permissions_employee_idx"
  ON "platform"."ops_permissions" ("employee_id");

COMMENT ON TABLE "platform"."ops_permissions" IS
  'P2-21b — Internal scope permissions on ops_employees. 5-value scope CHECK (CRM_READ, CRM_WRITE, TENANT_ACCESS, INTERNAL_ADMIN, SUPPORT). UNIQUE(employee_id, scope) caps each scope at one row per employee. CASCADE on employee delete drops their permissions. granted_by is RESTRICT — historical audit on who granted.';


-- ── ops_account_assignments ──────────────────────────────────────────
-- Maps ops_employees to CRM accounts (CSM, TAM, AE). Used by the
-- account dashboard to show "your accounts" for a CSM.

CREATE TABLE IF NOT EXISTS "platform"."ops_account_assignments" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "assignment_role" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_account_assignments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ops_account_assignments_employee_fkey" FOREIGN KEY ("employee_id")
      REFERENCES "platform"."ops_employees"("id") ON DELETE CASCADE,
    CONSTRAINT "ops_account_assignments_role_chk" CHECK (
      "assignment_role" IN ('CSM', 'TAM', 'AE')
    ),
    CONSTRAINT "ops_account_assignments_account_employee_uq"
      UNIQUE ("account_id", "employee_id")
);

CREATE INDEX IF NOT EXISTS "ops_account_assignments_employee_idx"
  ON "platform"."ops_account_assignments" ("employee_id");

CREATE INDEX IF NOT EXISTS "ops_account_assignments_account_idx"
  ON "platform"."ops_account_assignments" ("account_id");

COMMENT ON TABLE "platform"."ops_account_assignments" IS
  'P2-21b — Maps ops_employees to crm_accounts (CSM/TAM/AE). UNIQUE(account_id, employee_id) so a single employee holds at most one assignment role per account. account_id is a soft FK to platform.crm_accounts(id) per ADR-001/020. CASCADE on employee delete.';


-- ── ops_tenant_access_grants ─────────────────────────────────────────
-- FERPA/GDPR-audited grants for CampusOS employees to enter a school
-- tenant. Hard 4-hour maximum enforced by CHECK; mandatory
-- justification of at least 20 characters; revocation tracked.
-- ADR-072. Emits ops.tenant_access.granted on insert via the
-- TenantAccessService.

CREATE TABLE IF NOT EXISTS "platform"."ops_tenant_access_grants" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "tenant_schema" TEXT NOT NULL,
    "justification" TEXT NOT NULL,
    "access_type" TEXT NOT NULL,
    "granted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "approved_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_tenant_access_grants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ops_tenant_access_grants_employee_fkey" FOREIGN KEY ("employee_id")
      REFERENCES "platform"."ops_employees"("id") ON DELETE RESTRICT,
    CONSTRAINT "ops_tenant_access_grants_approver_fkey" FOREIGN KEY ("approved_by")
      REFERENCES "platform"."ops_employees"("id") ON DELETE RESTRICT,
    CONSTRAINT "ops_tenant_access_grants_access_type_chk" CHECK (
      "access_type" IN ('READ_ONLY', 'READ_WRITE')
    ),
    CONSTRAINT "ops_tenant_access_grants_justification_chk" CHECK (
      length(trim("justification")) >= 20
    ),
    CONSTRAINT "ops_tenant_access_grants_duration_chk" CHECK (
      "expires_at" <= "granted_at" + INTERVAL '4 hours'
    ),
    CONSTRAINT "ops_tenant_access_grants_window_chk" CHECK (
      "expires_at" > "granted_at"
    ),
    CONSTRAINT "ops_tenant_access_grants_revoked_chk" CHECK (
      "revoked_at" IS NULL OR "revoked_at" >= "granted_at"
    )
);

CREATE INDEX IF NOT EXISTS "ops_tenant_access_grants_active_idx"
  ON "platform"."ops_tenant_access_grants" ("employee_id", "expires_at")
  WHERE "revoked_at" IS NULL;

CREATE INDEX IF NOT EXISTS "ops_tenant_access_grants_schema_idx"
  ON "platform"."ops_tenant_access_grants" ("tenant_schema");

CREATE INDEX IF NOT EXISTS "ops_tenant_access_grants_granted_idx"
  ON "platform"."ops_tenant_access_grants" ("granted_at" DESC);

COMMENT ON TABLE "platform"."ops_tenant_access_grants" IS
  'P2-21b — FERPA/GDPR-audited grants for CampusOS employees to enter a school tenant schema. Hard 4-hour maximum (duration_chk). Mandatory justification of at least 20 characters (justification_chk). Revocation tracked via revoked_at (partial INDEX on active grants). Emits ops.tenant_access.granted via the TenantAccessService. ADR-072.';

COMMENT ON COLUMN "platform"."ops_tenant_access_grants"."justification" IS
  'Plain-text rationale for the access. CHECK enforces length >= 20 after trim. Surfaces in the audit log.';

COMMENT ON COLUMN "platform"."ops_tenant_access_grants"."expires_at" IS
  'Hard upper bound enforced by duration_chk: expires_at <= granted_at + 4 hours. Cannot grant a long-lived window without splitting into multiple grants.';

COMMENT ON COLUMN "platform"."ops_tenant_access_grants"."approved_by" IS
  'ops_employees.id of the approver. RESTRICT — historical audit on who approved the grant.';


-- ── ops_internal_tickets ─────────────────────────────────────────────
-- Internal cross-team work tracking for CampusOS-the-company.
-- Distinct from school helpdesk tkt_tickets which is tenant-scoped.

CREATE TABLE IF NOT EXISTS "platform"."ops_internal_tickets" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "created_by" UUID NOT NULL,
    "assigned_to" UUID,
    "related_account_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_internal_tickets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ops_internal_tickets_created_by_fkey" FOREIGN KEY ("created_by")
      REFERENCES "platform"."ops_employees"("id") ON DELETE RESTRICT,
    CONSTRAINT "ops_internal_tickets_assigned_to_fkey" FOREIGN KEY ("assigned_to")
      REFERENCES "platform"."ops_employees"("id") ON DELETE SET NULL,
    CONSTRAINT "ops_internal_tickets_category_chk" CHECK (
      "category" IN ('BUG', 'FEATURE_REQUEST', 'DATA_FIX', 'INFRASTRUCTURE', 'OTHER')
    ),
    CONSTRAINT "ops_internal_tickets_priority_chk" CHECK (
      "priority" IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')
    ),
    CONSTRAINT "ops_internal_tickets_status_chk" CHECK (
      "status" IN ('OPEN', 'IN_PROGRESS', 'BLOCKED', 'RESOLVED', 'CLOSED')
    )
);

CREATE INDEX IF NOT EXISTS "ops_internal_tickets_status_priority_idx"
  ON "platform"."ops_internal_tickets" ("status", "priority");

CREATE INDEX IF NOT EXISTS "ops_internal_tickets_assigned_idx"
  ON "platform"."ops_internal_tickets" ("assigned_to") WHERE "assigned_to" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ops_internal_tickets_account_idx"
  ON "platform"."ops_internal_tickets" ("related_account_id")
  WHERE "related_account_id" IS NOT NULL;

COMMENT ON TABLE "platform"."ops_internal_tickets" IS
  'P2-21b — Internal tickets for CampusOS-the-company cross-team work. 5-value category, 4-value priority, 5-value status. Distinct from school helpdesk tkt_tickets (tenant-scoped). related_account_id is a soft FK to platform.crm_accounts(id) per ADR-001/020. created_by RESTRICT (audit), assigned_to SET NULL (reassign on operator leave).';


-- ── ops_internal_ticket_comments ─────────────────────────────────────
-- Append-only comment thread on internal tickets. CASCADE on parent
-- ticket — comments without their ticket are meaningless.

CREATE TABLE IF NOT EXISTS "platform"."ops_internal_ticket_comments" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "comment_text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_internal_ticket_comments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ops_internal_ticket_comments_ticket_fkey" FOREIGN KEY ("ticket_id")
      REFERENCES "platform"."ops_internal_tickets"("id") ON DELETE CASCADE,
    CONSTRAINT "ops_internal_ticket_comments_author_fkey" FOREIGN KEY ("author_id")
      REFERENCES "platform"."ops_employees"("id") ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS "ops_internal_ticket_comments_ticket_idx"
  ON "platform"."ops_internal_ticket_comments" ("ticket_id", "created_at");

COMMENT ON TABLE "platform"."ops_internal_ticket_comments" IS
  'P2-21b — Append-only comment thread on internal tickets. CASCADE on parent ticket; author RESTRICT for audit.';


-- ── platform_pricing_bands ───────────────────────────────────────────
-- Pricing by school size. Bands address contiguous student-count
-- ranges. CRM accounts pricing_band_id is a soft FK to one of these.

CREATE TABLE IF NOT EXISTS "platform"."platform_pricing_bands" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "student_range_min" INT NOT NULL,
    "student_range_max" INT,
    "monthly_price_cents" INT NOT NULL,
    "annual_price_cents" INT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_pricing_bands_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_pricing_bands_name_uq" UNIQUE ("name"),
    CONSTRAINT "platform_pricing_bands_range_chk" CHECK (
      "student_range_min" >= 0 AND
      ("student_range_max" IS NULL OR "student_range_max" >= "student_range_min")
    ),
    CONSTRAINT "platform_pricing_bands_monthly_chk" CHECK ("monthly_price_cents" >= 0),
    CONSTRAINT "platform_pricing_bands_annual_chk" CHECK ("annual_price_cents" >= 0)
);

CREATE INDEX IF NOT EXISTS "platform_pricing_bands_active_idx"
  ON "platform"."platform_pricing_bands" ("is_active") WHERE "is_active" = true;

COMMENT ON TABLE "platform"."platform_pricing_bands" IS
  'P2-21b — Pricing bands by school size. Bands describe contiguous student-count ranges with monthly + annual cents. UNIQUE(name). student_range_max nullable = open-ended top band. Non-negative cents CHECKs. is_active flag for soft deactivation; the PricingService refuses to delete a band that has crm_accounts pricing_band_id referencing it.';


-- ── platform_pricing_history ─────────────────────────────────────────
-- Append-only audit trail of price changes. Created by
-- PricingService.update — never UPDATEd or DELETEd at the service
-- layer.

CREATE TABLE IF NOT EXISTS "platform"."platform_pricing_history" (
    "id" UUID NOT NULL,
    "band_id" UUID NOT NULL,
    "previous_monthly_cents" INT,
    "new_monthly_cents" INT NOT NULL,
    "previous_annual_cents" INT,
    "new_annual_cents" INT NOT NULL,
    "effective_date" DATE NOT NULL,
    "changed_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_pricing_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_pricing_history_band_fkey" FOREIGN KEY ("band_id")
      REFERENCES "platform"."platform_pricing_bands"("id") ON DELETE CASCADE,
    CONSTRAINT "platform_pricing_history_changed_by_fkey" FOREIGN KEY ("changed_by")
      REFERENCES "platform"."ops_employees"("id") ON DELETE RESTRICT,
    CONSTRAINT "platform_pricing_history_monthly_chk" CHECK ("new_monthly_cents" >= 0),
    CONSTRAINT "platform_pricing_history_annual_chk" CHECK ("new_annual_cents" >= 0),
    CONSTRAINT "platform_pricing_history_prev_monthly_chk" CHECK (
      "previous_monthly_cents" IS NULL OR "previous_monthly_cents" >= 0
    ),
    CONSTRAINT "platform_pricing_history_prev_annual_chk" CHECK (
      "previous_annual_cents" IS NULL OR "previous_annual_cents" >= 0
    )
);

CREATE INDEX IF NOT EXISTS "platform_pricing_history_band_effective_idx"
  ON "platform"."platform_pricing_history" ("band_id", "effective_date" DESC);

COMMENT ON TABLE "platform"."platform_pricing_history" IS
  'P2-21b — Append-only audit trail of price changes per band. CASCADE on band delete since the history is meaningless without its band; changed_by RESTRICT (audit). Service-side IMMUTABLE — PricingService never UPDATEs or DELETEs rows here.';


-- ── platform_support_tiers ───────────────────────────────────────────
-- Definition of support tiers (Standard, Premium, Enterprise) with
-- response-time SLA + phone/CSM inclusion + monthly add-on.

CREATE TABLE IF NOT EXISTS "platform"."platform_support_tiers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "response_time_hours" INT NOT NULL,
    "includes_phone" BOOLEAN NOT NULL DEFAULT false,
    "includes_dedicated_csm" BOOLEAN NOT NULL DEFAULT false,
    "monthly_addon_cents" INT NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_support_tiers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_support_tiers_name_uq" UNIQUE ("name"),
    CONSTRAINT "platform_support_tiers_response_chk" CHECK ("response_time_hours" > 0),
    CONSTRAINT "platform_support_tiers_addon_chk" CHECK ("monthly_addon_cents" >= 0)
);

CREATE INDEX IF NOT EXISTS "platform_support_tiers_active_idx"
  ON "platform"."platform_support_tiers" ("is_active") WHERE "is_active" = true;

COMMENT ON TABLE "platform"."platform_support_tiers" IS
  'P2-21b — Support tier catalogue. UNIQUE(name). Positive response_time_hours CHECK. Non-negative monthly_addon_cents CHECK. is_active flag for soft deactivation.';
