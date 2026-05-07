-- Cycle 32 Step 6 — home_region enforcement on tenant routing.
-- Adds platform_tenant_routing.home_region with default 'us-east-1'
-- so existing tenants stay on the primary US cluster. EU/UK tenants
-- get migrated to 'eu-west-2' as part of their onboarding.
-- Per ADR-042 + Architecture Review §21.2 active-passive topology.

ALTER TABLE "platform"."platform_tenant_routing"
  ADD COLUMN IF NOT EXISTS "home_region" TEXT NOT NULL DEFAULT 'us-east-1';

CREATE INDEX IF NOT EXISTS "platform_tenant_routing_home_region_idx"
  ON "platform"."platform_tenant_routing" ("home_region");

COMMENT ON COLUMN "platform"."platform_tenant_routing"."home_region" IS
  'Cycle 32 Step 6 — region affinity. RegionMismatchInterceptor rejects requests with HTTP 421 when process.env.AWS_REGION does not match this column. EU/UK tenants must be set to eu-west-2 per GDPR data residency.';
