import {
  runWithTenantContextAsync,
  type RequestContext,
  type TenantInfo,
} from '../../../src/tenant/tenant.context';

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

export const TEST_TENANT: TenantInfo = {
  schoolId: TEST_SCHOOL_ID,
  schemaName: TEST_SCHEMA,
  organisationId: TEST_ORG_ID,
  subdomain: TEST_SUBDOMAIN,
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
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
