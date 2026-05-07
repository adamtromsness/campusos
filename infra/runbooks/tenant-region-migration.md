# Tenant Region Migration Procedure

**Cycle 32 Step 6 — runbook.** Procedure for moving a tenant from
one region to another (e.g., a US school opens a UK campus and needs
GDPR data residency in the EU).

Estimated downtime: **<30 minutes per tenant**. Performed during a
scheduled maintenance window communicated to the school 7 days in
advance.

## Prerequisites

- Source region cluster + target region cluster both online and
  reachable.
- `home_region` column on `platform.platform_tenant_routing` (Cycle
  32 migration `20260507163514_add_home_region_to_tenant_routing`).
- Operator has read+write access to both regional databases via the
  ops Terraform pipeline.
- Schools relations team has confirmed the maintenance window with
  the affected tenant.

## Step-by-step

1. **Set the tenant frozen.** A frozen tenant accepts reads but
   refuses writes. Cycle 0 ADR-031 contract.

   ```sql
   UPDATE platform.platform_tenant_routing
      SET is_frozen = true,
          is_migrating = true
    WHERE tenant_id = $tenant_id;
   ```

2. **Wait for in-flight writes to drain.** ECS task health checks
   show no active write traffic for 30 seconds.

3. **Capture the source schema dump.**

   ```bash
   PGHOST=$SOURCE_PRIMARY pg_dump \
     --schema=tenant_${tenant_subdomain} \
     --no-owner --no-acl \
     --format=custom \
     --file=/tmp/${tenant_subdomain}.dump \
     campusos
   ```

4. **Provision the target schema.** The target region must already
   have an empty schema with the same migration set applied as the
   source. Use the standard `provision-tenant.ts` against the
   target region:

   ```bash
   AWS_REGION=$TARGET_REGION \
   DATABASE_URL=postgres://campusos:***@$TARGET_PRIMARY/campusos \
   pnpm --filter @campusos/database provision --subdomain=${tenant_subdomain}
   ```

5. **Restore the dump into the target.**

   ```bash
   PGHOST=$TARGET_PRIMARY pg_restore \
     --dbname=campusos \
     --schema=tenant_${tenant_subdomain} \
     --no-owner --no-acl \
     --data-only \
     /tmp/${tenant_subdomain}.dump
   ```

6. **Verify row counts match.** Spot check the same 10 critical
   tables from `tools/failover/backup-validate-row-counts.sh`.

7. **Update `home_region`.** Atomic flip on the platform table.

   ```sql
   UPDATE platform.platform_tenant_routing
      SET home_region = '$target_region',
          is_migrating = false
    WHERE tenant_id = $tenant_id;
   ```

8. **Update Route 53.** Either DNS-level latency-based routing
   (preferred — caller resolves to the right region automatically)
   or explicit weighted routing for the tenant's subdomain to point
   to the target region's API gateway.

9. **Unfreeze.**

   ```sql
   UPDATE platform.platform_tenant_routing
      SET is_frozen = false
    WHERE tenant_id = $tenant_id;
   ```

10. **Verify the new home region.** From a client, hit
    `/api/v1/auth/me` with the tenant subdomain header and confirm
    the response (or the response server-region header) reflects the
    target region.

10a. **Verify platform-schema cross-region visibility.**
REVIEW-CYCLE32 MAJOR 7 — the platform schema is in the Global
Database and replicates automatically, but operators must
confirm the rows that link to the migrated tenant are actually
visible from the target region BEFORE unfreeze. Run the same
`psql` queries against the target region's primary writer:

     ```sql
     -- Tenant routing row reflects new home_region.
     SELECT tenant_id, schema_name, home_region, is_frozen, is_migrating
       FROM platform.platform_tenant_routing
      WHERE tenant_id = $tenant_id;
     -- Expect: home_region matches target_region; is_migrating=false.

     -- IAM person rows for this tenant's users are present.
     SELECT count(*) FROM platform.iam_person ip
       JOIN platform.platform_users pu ON pu.person_id = ip.id
      WHERE pu.subdomain = $tenant_subdomain;
     -- Expect: matches the source-region count.

     -- Audit log rows for this tenant are present (last 24h).
     SELECT count(*) FROM platform.platform_audit_log
      WHERE tenant_id = $tenant_id
        AND created_at > now() - interval '24 hours';
     -- Expect: matches source-region count within ±1.

     -- DLQ rows scoped to this tenant are present.
     SELECT count(*) FROM platform.platform_dlq_messages
      WHERE tenant_id = $tenant_id AND resolved_at IS NULL;
     -- Expect: matches source-region count exactly.
     ```

     Any drift here means Global Database replication has not
     converged. **Do not unfreeze** until the counts match. The
     downstream app-layer region-routing gate
     (Cycle 32 Step 6 `RegionMismatchInterceptor`) depends on
     `platform_tenant_routing.home_region` being readable from the
     target region — without that, every request to the target
     region's API would 421.

11. **Decommission the source schema** (after a 30-day retention
    window):

    ```sql
    DROP SCHEMA tenant_${tenant_subdomain} CASCADE;  -- on source region
    ```

## Cycle 30 DPO request scope

`dpo_subject_access_requests` and `dpo_erasure_requests` are
processed in the tenant's home region only — the
`@HomeRegionRequired()` decorator on `GovernanceController` rejects
cross-region requests with HTTP 421. After region migration:

- In-flight DPO requests: must complete in the source region BEFORE
  step 1. The frozen window is the cutover, so DPOs must complete
  their queue first or queue items move to the target on cutover.
- Historical DPO records: replicate via `pg_dump` → `pg_restore`. The
  IMMUTABLE pseudonymisation log preserves the audit chain across
  the migration.

## Rollback

If verification fails at step 10:

1. Update `home_region` back to the source region.
2. Update Route 53 back to the source endpoint.
3. Unfreeze.
4. Investigate the data-parity failure on the target before retrying.

The source schema is preserved through the maintenance window so
rollback is a metadata-only operation.

## Cross-region replication during migration

`platform.iam_person`, `platform.platform_users`, and other platform
schema tables stay in the global database — they replicate
automatically. Only the tenant-schema data (`tenant_<subdomain>.*`)
needs the dump+restore.
