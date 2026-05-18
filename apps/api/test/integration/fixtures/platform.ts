import type { PrismaClient } from '@prisma/client';
import {
  TEST_ORG_ID,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_ROUTING_ID,
  TEST_SUBDOMAIN,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import { TEST_ADMIN_PERSON_ID, TEST_ADMIN_ACCOUNT_ID } from '../helpers/actor';

// School B routing — same schema, different school_id. See tenant-context.ts.
const TEST_ROUTING_B_ID = '019e0cf8-aaaa-7777-8888-00000000000c';

// Wave 2 — iam_scope rows for SCHOOL-tier scope resolution.
// PermissionCheckService.resolveScopeChain looks up iam_scope rows by
// entity_id + scope_type. The PLATFORM scope is seeded once by the
// platform seed; the SCHOOL scopes for the test schools need fixture
// seeding so any Wave 2 test that drives PermissionCheckService finds
// a [SCHOOL, PLATFORM] chain.
export const TEST_SCHOOL_SCOPE_ID = '019e0cf8-aaaa-7777-8888-00000000000d';
export const TEST_SCHOOL_B_SCOPE_ID = '019e0cf8-aaaa-7777-8888-00000000000e';

/**
 * Platform-side fixtures. Inserted once per suite run by globalSetup
 * with ON CONFLICT DO NOTHING so re-runs are no-ops.
 *
 * Per the design doc fixture strategy: these are stable across the
 * entire integration suite. Tests do NOT mutate or clean up these
 * rows — they are the test infrastructure. Procurement-specific rows
 * are seeded per test body via fixtures/procurement.ts (Loop 3+).
 */
export async function ensurePlatformFixtures(prisma: PrismaClient): Promise<void> {
  // Organisation
  await prisma.$executeRawUnsafe(
    `INSERT INTO platform.organisations (id, name, country_code, org_type)
     VALUES ($1::uuid, 'Integration Test Org', 'US', 'INDEPENDENT_GROUP')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ORG_ID,
  );

  // School
  await prisma.$executeRawUnsafe(
    `INSERT INTO platform.schools (id, organisation_id, name, subdomain, country_code, timezone, plan_tier, schema_name, is_active)
     VALUES ($1::uuid, $2::uuid, 'Integration Test School', $3, 'US', 'America/Chicago', 'MEDIUM', $4, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_SCHOOL_ID,
    TEST_ORG_ID,
    TEST_SUBDOMAIN,
    TEST_SCHEMA,
  );

  // Tenant routing — required for TenantPrismaService to resolve the schema
  await prisma.$executeRawUnsafe(
    `INSERT INTO platform.platform_tenant_routing (id, tenant_id, cluster_id, schema_name, home_region, is_active, is_frozen, is_migrating, max_connections_pool)
     VALUES ($1::uuid, $2::uuid, 'primary', $3, 'us-east-1', true, false, false, 10)
     ON CONFLICT (tenant_id) DO NOTHING`,
    TEST_ROUTING_ID,
    TEST_SCHOOL_ID,
    TEST_SCHEMA,
  );

  // School B — second school in the same org / same tenant schema. Used by
  // Wave 1 cross-school isolation tests. Services scope every SQL predicate
  // by tenant.schoolId, so seeding rows with this school_id and switching
  // the tenant context exercises the cross-school contract.
  await prisma.$executeRawUnsafe(
    `INSERT INTO platform.schools (id, organisation_id, name, subdomain, country_code, timezone, plan_tier, schema_name, is_active)
     VALUES ($1::uuid, $2::uuid, 'Integration Test School B', $3, 'US', 'America/Chicago', 'MEDIUM', $4, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_SCHOOL_B_ID,
    TEST_ORG_ID,
    TEST_SUBDOMAIN + '-b',
    TEST_SCHEMA,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO platform.platform_tenant_routing (id, tenant_id, cluster_id, schema_name, home_region, is_active, is_frozen, is_migrating, max_connections_pool)
     VALUES ($1::uuid, $2::uuid, 'primary', $3, 'us-east-1', true, false, false, 10)
     ON CONFLICT (tenant_id) DO NOTHING`,
    TEST_ROUTING_B_ID,
    TEST_SCHOOL_B_ID,
    TEST_SCHEMA,
  );

  // Admin actor identity (iam_person + platform_users)
  await prisma.$executeRawUnsafe(
    `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
     VALUES ($1::uuid, 'Integration', 'Admin', 'STAFF', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ADMIN_PERSON_ID,
  );

  await prisma.$executeRawUnsafe(
    `INSERT INTO platform.platform_users (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
     VALUES ($1::uuid, $2::uuid, 'admin@test.integration.local', 'Integration Admin', 'ACTIVE', 'HUMAN', false)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ADMIN_ACCOUNT_ID,
    TEST_ADMIN_PERSON_ID,
  );

  // Wave 2 — SCHOOL iam_scope rows for both test schools. Looked up by
  // entity_id by PermissionCheckService.resolveScopeChain. PLATFORM
  // iam_scope row is provided by the platform seed (one global row).
  await prisma.$executeRawUnsafe(
    `INSERT INTO platform.iam_scope (id, scope_type_id, entity_id, entity_table, label, is_active)
     SELECT $1::uuid, st.id, $2::uuid, 'platform.schools', 'Integration Test School A', true
       FROM platform.iam_scope_type st WHERE st.code = 'SCHOOL'
     ON CONFLICT (scope_type_id, entity_id) DO NOTHING`,
    TEST_SCHOOL_SCOPE_ID,
    TEST_SCHOOL_ID,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO platform.iam_scope (id, scope_type_id, entity_id, entity_table, label, is_active)
     SELECT $1::uuid, st.id, $2::uuid, 'platform.schools', 'Integration Test School B', true
       FROM platform.iam_scope_type st WHERE st.code = 'SCHOOL'
     ON CONFLICT (scope_type_id, entity_id) DO NOTHING`,
    TEST_SCHOOL_B_SCOPE_ID,
    TEST_SCHOOL_B_ID,
  );
}

/**
 * Sanity check called by globalSetup AFTER ensurePlatformFixtures —
 * fails fast if any required row is missing so the rest of the suite
 * doesn't surface confusing FK errors per test. Per the user's "trust
 * shared fixtures, assert once in setup" guidance.
 */
export async function assertPlatformFixtures(prisma: PrismaClient): Promise<void> {
  const checks: Array<{ label: string; sql: string }> = [
    {
      label: 'organisations',
      sql: `SELECT 1 FROM platform.organisations WHERE id = '${TEST_ORG_ID}'::uuid`,
    },
    {
      label: 'schools',
      sql: `SELECT 1 FROM platform.schools WHERE id = '${TEST_SCHOOL_ID}'::uuid`,
    },
    {
      label: 'platform_tenant_routing',
      sql: `SELECT 1 FROM platform.platform_tenant_routing WHERE tenant_id = '${TEST_SCHOOL_ID}'::uuid AND schema_name = '${TEST_SCHEMA}'`,
    },
    {
      label: 'schools (School B)',
      sql: `SELECT 1 FROM platform.schools WHERE id = '${TEST_SCHOOL_B_ID}'::uuid`,
    },
    {
      label: 'platform_tenant_routing (School B)',
      sql: `SELECT 1 FROM platform.platform_tenant_routing WHERE tenant_id = '${TEST_SCHOOL_B_ID}'::uuid AND schema_name = '${TEST_SCHEMA}'`,
    },
    {
      label: 'iam_scope (School A SCHOOL-tier)',
      sql: `SELECT 1 FROM platform.iam_scope s JOIN platform.iam_scope_type st ON st.id = s.scope_type_id WHERE s.entity_id = '${TEST_SCHOOL_ID}'::uuid AND st.code = 'SCHOOL'`,
    },
    {
      label: 'iam_scope (School B SCHOOL-tier)',
      sql: `SELECT 1 FROM platform.iam_scope s JOIN platform.iam_scope_type st ON st.id = s.scope_type_id WHERE s.entity_id = '${TEST_SCHOOL_B_ID}'::uuid AND st.code = 'SCHOOL'`,
    },
    {
      label: 'iam_person (admin)',
      sql: `SELECT 1 FROM platform.iam_person WHERE id = '${TEST_ADMIN_PERSON_ID}'::uuid`,
    },
    {
      label: 'platform_users (admin)',
      sql: `SELECT 1 FROM platform.platform_users WHERE id = '${TEST_ADMIN_ACCOUNT_ID}'::uuid`,
    },
  ];
  for (const check of checks) {
    const rows = (await prisma.$queryRawUnsafe(check.sql)) as unknown[];
    if (rows.length === 0) {
      throw new Error(
        `Integration test fixture missing: ${check.label}. ` +
          `Re-run globalSetup or delete tenant_test and try again.`,
      );
    }
  }
}
