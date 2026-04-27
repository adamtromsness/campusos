import { AsyncLocalStorage } from 'async_hooks';

/**
 * Tenant Context — AsyncLocalStorage
 *
 * Carries tenant identity through the entire request lifecycle
 * without passing parameters. Accessible from any service.
 *
 * Architecture (Dev Plan Section 18):
 * - Every HTTP request resolves to a tenant before business logic
 * - The context is set by TenantResolverMiddleware
 * - Prisma reads from this context to set search_path
 * - If no context exists, queries are rejected (never default schema)
 */

export interface TenantInfo {
  schoolId: string;
  schemaName: string;
  organisationId: string | null;
  subdomain: string;
  isFrozen: boolean;
  planTier: string;
}

export interface RequestContext {
  tenant: TenantInfo;
  userId?: string;
  personId?: string;
  sessionId?: string;
}

// Global AsyncLocalStorage instance
var tenantStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Get the current request context.
 * Returns undefined if called outside a request (e.g. in a worker).
 */
export function getRequestContext(): RequestContext | undefined {
  return tenantStorage.getStore();
}

/**
 * Get the current tenant. Throws if no tenant context exists.
 * Use this in services that MUST have a tenant.
 */
export function getCurrentTenant(): TenantInfo {
  var ctx = tenantStorage.getStore();
  if (!ctx || !ctx.tenant) {
    throw new Error('No tenant context — request was not resolved to a tenant');
  }
  return ctx.tenant;
}

/**
 * Get the current user ID. Returns undefined if not authenticated.
 */
export function getCurrentUserId(): string | undefined {
  var ctx = tenantStorage.getStore();
  return ctx?.userId;
}

/**
 * Run a function within a tenant context.
 * Used by the middleware to wrap the request lifecycle.
 */
export function runWithTenantContext<T>(context: RequestContext, fn: () => T): T {
  return tenantStorage.run(context, fn);
}

/**
 * Run a function within a tenant context (async version).
 */
export function runWithTenantContextAsync<T>(
  context: RequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  return tenantStorage.run(context, fn);
}

export { tenantStorage };
