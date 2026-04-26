-- CreateEnum
CREATE TYPE "platform"."OrgType" AS ENUM ('DISTRICT', 'MAT', 'INDEPENDENT_GROUP');

-- CreateEnum
CREATE TYPE "platform"."PlanTier" AS ENUM ('SMALL', 'MEDIUM', 'LARGE', 'ENTERPRISE');

-- CreateTable
CREATE TABLE "platform"."organisations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "country_code" CHAR(2),
    "org_type" "platform"."OrgType" NOT NULL DEFAULT 'INDEPENDENT_GROUP',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organisations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."schools" (
    "id" UUID NOT NULL,
    "organisation_id" UUID,
    "name" TEXT NOT NULL,
    "subdomain" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "timezone" TEXT NOT NULL,
    "plan_tier" "platform"."PlanTier" NOT NULL DEFAULT 'SMALL',
    "schema_name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_tenant_routing" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cluster_id" TEXT NOT NULL DEFAULT 'primary',
    "schema_name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_frozen" BOOLEAN NOT NULL DEFAULT false,
    "is_migrating" BOOLEAN NOT NULL DEFAULT false,
    "migrated_at" TIMESTAMPTZ,
    "max_connections_pool" INTEGER NOT NULL DEFAULT 10,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_tenant_routing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_audit_log" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_type" TEXT NOT NULL DEFAULT 'HUMAN',
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "tenant_id" UUID,
    "metadata" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_event_consumer_idempotency" (
    "id" UUID NOT NULL,
    "consumer_group" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_event_consumer_idempotency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "schools_subdomain_key" ON "platform"."schools"("subdomain");

-- CreateIndex
CREATE INDEX "schools_subdomain_idx" ON "platform"."schools"("subdomain");

-- CreateIndex
CREATE UNIQUE INDEX "platform_tenant_routing_tenant_id_key" ON "platform"."platform_tenant_routing"("tenant_id");

-- CreateIndex
CREATE INDEX "platform_audit_log_actor_id_created_at_idx" ON "platform"."platform_audit_log"("actor_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "platform_audit_log_entity_type_entity_id_idx" ON "platform"."platform_audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "platform_audit_log_tenant_id_created_at_idx" ON "platform"."platform_audit_log"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "platform_event_consumer_idempotency_processed_at_idx" ON "platform"."platform_event_consumer_idempotency"("processed_at");

-- CreateIndex
CREATE UNIQUE INDEX "platform_event_consumer_idempotency_consumer_group_event_id_key" ON "platform"."platform_event_consumer_idempotency"("consumer_group", "event_id");

-- AddForeignKey
ALTER TABLE "platform"."schools" ADD CONSTRAINT "schools_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "platform"."organisations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."platform_tenant_routing" ADD CONSTRAINT "platform_tenant_routing_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
