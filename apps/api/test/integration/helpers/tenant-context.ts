import {
  runWithTenantContextAsync,
  type RequestContext,
  type TenantInfo,
} from '@shared/tenant/tenant.context';

/**
 * Stable, deterministic test identity constants. UUIDs are reserved
 * specifically for the integration test fixture set so they cannot
 * collide with real seeded data. The 'aaaa-7777-8888-0000000000xx'
 * suffix pattern is unique to this harness.
 */
export const TEST_ORG_ID = '019e0cf8-aaaa-7777-8888-000000000001';
export const TEST_SCHOOL_ID = '019e0cf8-aaaa-7777-8888-000000000002';
export const TEST_ROUTING_ID = '019e0cf8-aaaa-7777-8888-000000000003';
export const TEST_SUBDOMAIN = 'test';
export const TEST_SCHEMA = 'tenant_test';

// School B — Wave 1 cross-school isolation tests. Same org, same tenant
// schema (tenant_test), different school_id. The services scope every
// SQL predicate by tenant.schoolId, so swapping the school_id in the
// tenant context is enough to exercise the cross-school contract
// without provisioning a second schema. Records seeded with this
// school_id are invisible to a School A actor and vice versa.
export const TEST_SCHOOL_B_ID = '019e0cf8-aaaa-7777-8888-00000000000b';

export const TEST_TENANT: TenantInfo = {
  schoolId: TEST_SCHOOL_ID,
  schemaName: TEST_SCHEMA,
  organisationId: TEST_ORG_ID,
  subdomain: TEST_SUBDOMAIN,
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

export const TEST_TENANT_B: TenantInfo = {
  ...TEST_TENANT,
  schoolId: TEST_SCHOOL_B_ID,
};

/**
 * Wrap a test body in the integration tenant context so all calls into
 * TenantPrismaService.executeInTenantContext / executeInTenantTransaction
 * resolve to tenant_test with the test school's school_id.
 *
 * Each call accepts optional userId / personId for services that read
 * the user context (most procurement services pass the actor explicitly
 * rather than reading from the request context, so those fields are
 * usually unset).
 */
export async function withTestTenant<T>(
  fn: () => Promise<T>,
  options?: { userId?: string; personId?: string; sessionId?: string },
): Promise<T> {
  const ctx: RequestContext = {
    tenant: TEST_TENANT,
    userId: options?.userId,
    personId: options?.personId,
    sessionId: options?.sessionId,
  };
  return runWithTenantContextAsync(ctx, fn);
}

/**
 * Wave 1 cross-school helper — runs the callback with the tenant context
 * pinned to School B (same schema, different school_id). Pair with
 * withTestTenant to assert that a School A actor cannot see or mutate
 * records owned by School B.
 */
export async function withTestTenantB<T>(
  fn: () => Promise<T>,
  options?: { userId?: string; personId?: string; sessionId?: string },
): Promise<T> {
  const ctx: RequestContext = {
    tenant: TEST_TENANT_B,
    userId: options?.userId,
    personId: options?.personId,
    sessionId: options?.sessionId,
  };
  return runWithTenantContextAsync(ctx, fn);
}
