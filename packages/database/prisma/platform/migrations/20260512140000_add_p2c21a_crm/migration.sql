-- P2-21a CRM (M90 Customer Management) — platform schema, internal-only.
--
-- 9 platform tables: crm_accounts, crm_subscriptions, crm_contacts,
-- crm_interactions, crm_onboarding_checklists, crm_onboarding_tasks,
-- crm_health_scores, crm_renewal_pipeline, crm_invoices.
--
-- ADR-071. Internal CRM for CampusOS-the-company. NOT visible to school
-- tenants. Accounts linked to schools/organisations with lifecycle
-- PROSPECT > PILOT > ONBOARDING > ACTIVE > CHURNED (+ SUSPENDED).
--
-- Soft UUID refs to platform.iam_person (champion, contacts, logged_by),
-- platform.schools (account school binding), platform.organisations
-- (account org binding). No DB FKs across platform-internal child tables
-- to those parents per the soft-ref convention.
-- =====================================================================

-- ── crm_accounts ─────────────────────────────────────────────────────
-- Master customer record. Lifecycle:
--   PROSPECT > PILOT (requires signed_date)
--          > ONBOARDING > ACTIVE (auto-flip when onboarding COMPLETED)
--          > CHURNED / SUSPENDED
-- school_id and organisation_id are both nullable but one must be set.

CREATE TABLE IF NOT EXISTS "platform"."crm_accounts" (
    "id" UUID NOT NULL,
    "school_id" UUID,
    "organisation_id" UUID,
    "account_name" TEXT NOT NULL,
    "pricing_band_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'PROSPECT',
    "billing_email" TEXT NOT NULL,
    "billing_address_json" JSONB,
    "stripe_customer_id" TEXT,
    "school_champion_person_id" UUID,
    "signed_date" DATE,
    "go_live_date" DATE,
    "renewal_date" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_accounts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crm_accounts_status_chk" CHECK (
      "status" IN ('PROSPECT', 'PILOT', 'ONBOARDING', 'ACTIVE', 'CHURNED', 'SUSPENDED')
    ),
    CONSTRAINT "crm_accounts_binding_chk" CHECK (
      "school_id" IS NOT NULL OR "organisation_id" IS NOT NULL
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "crm_accounts_stripe_customer_id_uq"
  ON "platform"."crm_accounts" ("stripe_customer_id")
  WHERE "stripe_customer_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "crm_accounts_status_idx"
  ON "platform"."crm_accounts" ("status");

CREATE INDEX IF NOT EXISTS "crm_accounts_renewal_active_idx"
  ON "platform"."crm_accounts" ("renewal_date")
  WHERE "status" = 'ACTIVE';

CREATE INDEX IF NOT EXISTS "crm_accounts_school_id_idx"
  ON "platform"."crm_accounts" ("school_id")
  WHERE "school_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "crm_accounts_organisation_id_idx"
  ON "platform"."crm_accounts" ("organisation_id")
  WHERE "organisation_id" IS NOT NULL;

COMMENT ON TABLE "platform"."crm_accounts" IS
  'P2-21a — CampusOS-the-company customer account record. Internal CRM, not visible to school tenants. Lifecycle PROSPECT > PILOT > ONBOARDING > ACTIVE > CHURNED (or SUSPENDED). PILOT requires signed_date. ONBOARDING > ACTIVE auto-flips when onboarding checklist COMPLETED. ADR-071.';

COMMENT ON COLUMN "platform"."crm_accounts"."school_id" IS
  'Soft FK to platform.schools(id) per ADR-001/020. Nullable when organisation_id is set instead (district-tier customer that hasnt mapped to a school yet).';

COMMENT ON COLUMN "platform"."crm_accounts"."organisation_id" IS
  'Soft FK to platform.organisations(id). Nullable when school_id is set instead (single-school customer).';

COMMENT ON COLUMN "platform"."crm_accounts"."pricing_band_id" IS
  'Soft FK to platform_pricing_bands(id) which ships in P2-21b. Nullable until pricing infrastructure is wired.';

COMMENT ON COLUMN "platform"."crm_accounts"."school_champion_person_id" IS
  'Soft FK to platform.iam_person(id) — the on-the-ground champion at the school whose advocacy drives the account.';

-- ── crm_subscriptions ────────────────────────────────────────────────
-- Billing subscription synced from Stripe. One account can in theory
-- carry multiple subscriptions (add-ons, support tiers) but the dominant
-- relationship is 1:1 with the principal plan.

CREATE TABLE IF NOT EXISTS "platform"."crm_subscriptions" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "plan_name" TEXT NOT NULL,
    "stripe_subscription_id" TEXT,
    "billing_interval" TEXT NOT NULL,
    "mrr_cents" INTEGER NOT NULL,
    "student_count_at_sign" INTEGER,
    "status" TEXT NOT NULL,
    "current_period_start" DATE,
    "current_period_end" DATE,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_subscriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crm_subscriptions_interval_chk" CHECK (
      "billing_interval" IN ('MONTHLY', 'ANNUAL')
    ),
    CONSTRAINT "crm_subscriptions_status_chk" CHECK (
      "status" IN ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED')
    ),
    CONSTRAINT "crm_subscriptions_mrr_chk" CHECK ("mrr_cents" >= 0),
    CONSTRAINT "crm_subscriptions_students_chk" CHECK (
      "student_count_at_sign" IS NULL OR "student_count_at_sign" >= 0
    ),
    CONSTRAINT "crm_subscriptions_period_chk" CHECK (
      "current_period_start" IS NULL OR "current_period_end" IS NULL
      OR "current_period_end" >= "current_period_start"
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "crm_subscriptions_stripe_id_uq"
  ON "platform"."crm_subscriptions" ("stripe_subscription_id")
  WHERE "stripe_subscription_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "crm_subscriptions_account_status_idx"
  ON "platform"."crm_subscriptions" ("account_id", "status");

ALTER TABLE "platform"."crm_subscriptions"
  ADD CONSTRAINT "crm_subscriptions_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "platform"."crm_accounts"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

COMMENT ON TABLE "platform"."crm_subscriptions" IS
  'P2-21a — Stripe-synced subscription rows per account. MRR aggregation source. Status TRIALING > ACTIVE > PAST_DUE / CANCELLED.';

-- ── crm_contacts ─────────────────────────────────────────────────────
-- People at the customer school we work with. Optional link to
-- iam_person if the contact has a CampusOS identity. is_primary at
-- most one per (account, role) — enforced at the service layer.

CREATE TABLE IF NOT EXISTS "platform"."crm_contacts" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "person_id" UUID,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "role" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_contacts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crm_contacts_role_chk" CHECK (
      "role" IN ('DECISION_MAKER', 'CHAMPION', 'ADMIN_CONTACT', 'BILLING_CONTACT', 'TECHNICAL_CONTACT', 'OTHER')
    )
);

CREATE INDEX IF NOT EXISTS "crm_contacts_account_idx"
  ON "platform"."crm_contacts" ("account_id");

ALTER TABLE "platform"."crm_contacts"
  ADD CONSTRAINT "crm_contacts_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "platform"."crm_accounts"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

COMMENT ON TABLE "platform"."crm_contacts" IS
  'P2-21a — People at the customer account. Optional iam_person link if the contact has a CampusOS identity.';

COMMENT ON COLUMN "platform"."crm_contacts"."person_id" IS
  'Soft FK to platform.iam_person(id) per ADR-001/020. Nullable for contacts who do not yet have a CampusOS identity.';

-- ── crm_interactions ─────────────────────────────────────────────────
-- Touch-points with the account. Logged by CSM/AE/Support.

CREATE TABLE IF NOT EXISTS "platform"."crm_interactions" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "contact_id" UUID,
    "interaction_type" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "notes" TEXT,
    "logged_by" UUID NOT NULL,
    "interaction_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_interactions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crm_interactions_type_chk" CHECK (
      "interaction_type" IN ('CALL', 'EMAIL', 'MEETING', 'DEMO', 'SUPPORT', 'NOTE', 'OTHER')
    )
);

CREATE INDEX IF NOT EXISTS "crm_interactions_account_time_idx"
  ON "platform"."crm_interactions" ("account_id", "interaction_at" DESC);

ALTER TABLE "platform"."crm_interactions"
  ADD CONSTRAINT "crm_interactions_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "platform"."crm_accounts"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "platform"."crm_interactions"
  ADD CONSTRAINT "crm_interactions_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "platform"."crm_contacts"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

COMMENT ON TABLE "platform"."crm_interactions" IS
  'P2-21a — Touch-point log per account: calls, emails, meetings, demos, support, notes. Drives the account timeline.';

COMMENT ON COLUMN "platform"."crm_interactions"."logged_by" IS
  'Soft FK to platform.iam_person(id) per ADR-001/020 — the CampusOS employee who logged the interaction.';

-- ── crm_onboarding_checklists ────────────────────────────────────────
-- One checklist per account, instantiated from a template at start.
-- On status > COMPLETED, OnboardingService auto-flips parent account
-- ONBOARDING > ACTIVE.

CREATE TABLE IF NOT EXISTS "platform"."crm_onboarding_checklists" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "template_version" INTEGER NOT NULL DEFAULT 1,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_onboarding_checklists_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crm_onboarding_checklists_status_chk" CHECK (
      "status" IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED')
    ),
    CONSTRAINT "crm_onboarding_checklists_started_chk" CHECK (
      ("status" = 'NOT_STARTED' AND "started_at" IS NULL)
      OR ("status" IN ('IN_PROGRESS', 'COMPLETED') AND "started_at" IS NOT NULL)
    ),
    CONSTRAINT "crm_onboarding_checklists_completed_chk" CHECK (
      ("status" <> 'COMPLETED' AND "completed_at" IS NULL)
      OR ("status" = 'COMPLETED' AND "completed_at" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "crm_onboarding_checklists_account_uq"
  ON "platform"."crm_onboarding_checklists" ("account_id");

ALTER TABLE "platform"."crm_onboarding_checklists"
  ADD CONSTRAINT "crm_onboarding_checklists_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "platform"."crm_accounts"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

COMMENT ON TABLE "platform"."crm_onboarding_checklists" IS
  'P2-21a — One onboarding checklist per account. Status NOT_STARTED > IN_PROGRESS > COMPLETED. Multi-column started_chk and completed_chk keep timestamps in lockstep. On COMPLETED, OnboardingService auto-flips parent account ONBOARDING > ACTIVE.';

-- ── crm_onboarding_tasks ─────────────────────────────────────────────
-- Per-checklist task rows. 5-value category. CASCADE on parent.

CREATE TABLE IF NOT EXISTS "platform"."crm_onboarding_tasks" (
    "id" UUID NOT NULL,
    "checklist_id" UUID NOT NULL,
    "task_name" TEXT NOT NULL,
    "task_category" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "completed_at" TIMESTAMPTZ,
    "completed_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_onboarding_tasks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crm_onboarding_tasks_category_chk" CHECK (
      "task_category" IN ('TECHNICAL', 'DATA_MIGRATION', 'TRAINING', 'CONFIGURATION', 'GO_LIVE')
    ),
    CONSTRAINT "crm_onboarding_tasks_status_chk" CHECK (
      "status" IN ('PENDING', 'COMPLETED', 'SKIPPED')
    ),
    CONSTRAINT "crm_onboarding_tasks_sort_chk" CHECK ("sort_order" >= 0),
    CONSTRAINT "crm_onboarding_tasks_completed_chk" CHECK (
      ("status" = 'PENDING' AND "completed_at" IS NULL AND "completed_by" IS NULL)
      OR ("status" IN ('COMPLETED', 'SKIPPED') AND "completed_at" IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS "crm_onboarding_tasks_checklist_sort_idx"
  ON "platform"."crm_onboarding_tasks" ("checklist_id", "sort_order");

ALTER TABLE "platform"."crm_onboarding_tasks"
  ADD CONSTRAINT "crm_onboarding_tasks_checklist_id_fkey"
  FOREIGN KEY ("checklist_id") REFERENCES "platform"."crm_onboarding_checklists"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

COMMENT ON TABLE "platform"."crm_onboarding_tasks" IS
  'P2-21a — Onboarding task rows per checklist. 5-value category TECHNICAL/DATA_MIGRATION/TRAINING/CONFIGURATION/GO_LIVE. Status PENDING > COMPLETED/SKIPPED. completed_chk keeps timestamp in lockstep.';

COMMENT ON COLUMN "platform"."crm_onboarding_tasks"."completed_by" IS
  'Soft FK to platform.iam_person(id). NULL on PENDING; populated when an employee marks the task COMPLETED or SKIPPED.';

-- ── crm_health_scores ────────────────────────────────────────────────
-- Weekly snapshot per account. Computed by HealthScoreWorker.
-- UNIQUE(account, score_date) makes re-runs idempotent.

CREATE TABLE IF NOT EXISTS "platform"."crm_health_scores" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "score_date" DATE NOT NULL,
    "overall_score" INTEGER NOT NULL,
    "adoption_score" INTEGER,
    "engagement_score" INTEGER,
    "support_ticket_score" INTEGER,
    "nps_score" INTEGER,
    "risk_level" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_health_scores_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crm_health_scores_overall_chk" CHECK (
      "overall_score" BETWEEN 0 AND 100
    ),
    CONSTRAINT "crm_health_scores_adoption_chk" CHECK (
      "adoption_score" IS NULL OR "adoption_score" BETWEEN 0 AND 100
    ),
    CONSTRAINT "crm_health_scores_engagement_chk" CHECK (
      "engagement_score" IS NULL OR "engagement_score" BETWEEN 0 AND 100
    ),
    CONSTRAINT "crm_health_scores_support_chk" CHECK (
      "support_ticket_score" IS NULL OR "support_ticket_score" BETWEEN 0 AND 100
    ),
    CONSTRAINT "crm_health_scores_nps_chk" CHECK (
      "nps_score" IS NULL OR "nps_score" BETWEEN -100 AND 100
    ),
    CONSTRAINT "crm_health_scores_risk_chk" CHECK (
      "risk_level" IN ('HEALTHY', 'AT_RISK', 'CRITICAL')
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "crm_health_scores_account_date_uq"
  ON "platform"."crm_health_scores" ("account_id", "score_date");

CREATE INDEX IF NOT EXISTS "crm_health_scores_risk_idx"
  ON "platform"."crm_health_scores" ("risk_level", "score_date" DESC);

ALTER TABLE "platform"."crm_health_scores"
  ADD CONSTRAINT "crm_health_scores_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "platform"."crm_accounts"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

COMMENT ON TABLE "platform"."crm_health_scores" IS
  'P2-21a — Weekly per-account health snapshot. overall_score 0..100, risk_level HEALTHY/AT_RISK/CRITICAL. Computed by HealthScoreWorker; UNIQUE(account, score_date) keeps reruns idempotent.';

-- ── crm_renewal_pipeline ─────────────────────────────────────────────
-- One row per upcoming renewal opportunity. Kanban-board grain.

CREATE TABLE IF NOT EXISTS "platform"."crm_renewal_pipeline" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "renewal_date" DATE NOT NULL,
    "current_mrr_cents" INTEGER NOT NULL,
    "proposed_mrr_cents" INTEGER,
    "stage" TEXT NOT NULL DEFAULT 'UPCOMING',
    "risk_factors" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "assigned_csm" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_renewal_pipeline_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crm_renewal_pipeline_stage_chk" CHECK (
      "stage" IN ('UPCOMING', 'IN_DISCUSSION', 'PROPOSAL_SENT', 'COMMITTED', 'CHURNING')
    ),
    CONSTRAINT "crm_renewal_pipeline_current_mrr_chk" CHECK ("current_mrr_cents" >= 0),
    CONSTRAINT "crm_renewal_pipeline_proposed_mrr_chk" CHECK (
      "proposed_mrr_cents" IS NULL OR "proposed_mrr_cents" >= 0
    )
);

CREATE INDEX IF NOT EXISTS "crm_renewal_pipeline_renewal_stage_idx"
  ON "platform"."crm_renewal_pipeline" ("renewal_date", "stage");

CREATE INDEX IF NOT EXISTS "crm_renewal_pipeline_account_idx"
  ON "platform"."crm_renewal_pipeline" ("account_id");

ALTER TABLE "platform"."crm_renewal_pipeline"
  ADD CONSTRAINT "crm_renewal_pipeline_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "platform"."crm_accounts"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

COMMENT ON TABLE "platform"."crm_renewal_pipeline" IS
  'P2-21a — Per-account renewal opportunity row. 5-stage Kanban UPCOMING > IN_DISCUSSION > PROPOSAL_SENT > COMMITTED / CHURNING. risk_factors free-form TEXT[].';

COMMENT ON COLUMN "platform"."crm_renewal_pipeline"."assigned_csm" IS
  'Soft FK to platform.iam_person(id) or to ops_employees.id (lands in P2-21b). NULL until a CSM picks up the renewal.';

-- ── crm_invoices ─────────────────────────────────────────────────────
-- Stripe-synced invoice per account.

CREATE TABLE IF NOT EXISTS "platform"."crm_invoices" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "stripe_invoice_id" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" TEXT NOT NULL,
    "invoice_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "paid_at" TIMESTAMPTZ,
    "pdf_url" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_invoices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crm_invoices_status_chk" CHECK (
      "status" IN ('DRAFT', 'OPEN', 'PAID', 'VOID')
    ),
    CONSTRAINT "crm_invoices_amount_chk" CHECK ("amount_cents" >= 0),
    CONSTRAINT "crm_invoices_paid_chk" CHECK (
      ("status" = 'PAID' AND "paid_at" IS NOT NULL)
      OR ("status" <> 'PAID' AND "paid_at" IS NULL)
    ),
    CONSTRAINT "crm_invoices_dates_chk" CHECK ("due_date" >= "invoice_date")
);

CREATE UNIQUE INDEX IF NOT EXISTS "crm_invoices_stripe_id_uq"
  ON "platform"."crm_invoices" ("stripe_invoice_id")
  WHERE "stripe_invoice_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "crm_invoices_account_date_idx"
  ON "platform"."crm_invoices" ("account_id", "invoice_date" DESC);

CREATE INDEX IF NOT EXISTS "crm_invoices_status_due_idx"
  ON "platform"."crm_invoices" ("status", "due_date")
  WHERE "status" IN ('DRAFT', 'OPEN');

ALTER TABLE "platform"."crm_invoices"
  ADD CONSTRAINT "crm_invoices_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "platform"."crm_accounts"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

COMMENT ON TABLE "platform"."crm_invoices" IS
  'P2-21a — Stripe-synced invoice per account. Status DRAFT > OPEN > PAID / VOID. paid_chk keeps paid_at in lockstep. dates_chk requires due_date >= invoice_date.';
